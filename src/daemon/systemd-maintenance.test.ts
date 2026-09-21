import "./service-definition-backup.mocks.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import * as commandExec from "../process/exec.js";
import { fixture, native } from "./service-definition-backup.test-support.js";
import * as serviceLayout from "./service-layout.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import {
  readGatewayServiceUpdateOriginalRoot,
  withGatewayServiceUpdateAuthority,
  type GatewayServiceNativeCommand,
} from "./service-update-authority.js";
import {
  prepareSystemdGatewayMaintenance,
  readSystemdGatewayStopTimeout,
} from "./systemd-maintenance.js";
import { buildSystemdUnit } from "./systemd-unit.js";

vi.mock("./service-layout.js", async (original) => ({
  ...(await original<typeof import("./service-layout.js")>()),
  gatewayServiceCommandMatchesRoot: async () => true,
}));

it.each([false, true])(
  "retains the explicit native runner and original owner during policy refresh (revoked: %s)",
  async (revoked) => {
    const f = await fixture("linux");
    f.command.environment = {
      ...f.command.environment,
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
      OPENCLAW_SERVICE_VERSION: "2026.7.1-2",
    };
    const original = buildSystemdUnit(f.command).replace("TimeoutStopSec=330", "TimeoutStopSec=30");
    await fs.writeFile(f.sourcePath, original);
    const unowned = vi
      .spyOn(commandExec, "runCommandWithTimeout")
      .mockRejectedValue(new Error("unowned native fallback"));
    const { execFileUtf8 } =
      await vi.importActual<typeof import("./exec-file.js")>("./exec-file.js");
    native.identity.mockImplementation(execFileUtf8);
    const roots: string[] = [];
    vi.spyOn(serviceLayout, "gatewayServiceCommandMatchesRoot").mockImplementation(async (root) => {
      roots.push(expectDefined(root, "Missing service root in policy-refresh ownership check"));
      expect(readGatewayServiceUpdateOriginalRoot()).toBe("/old");
      if (root === "/old" && revoked) {
        f.expire();
      }
      return root === "/old";
    });
    const commands: string[][] = [];
    const runner = vi.fn<GatewayServiceNativeCommand>(async (argv) => {
      expect(readGatewayServiceUpdateOriginalRoot()).toBe("/old");
      commands.push(argv);
      const unit = await fs.readFile(f.sourcePath, "utf8");
      return {
        code: 0,
        stdout: `LoadState=loaded\nAfter=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nTimeoutStopUSec=${/^TimeoutStopSec=(\d+)$/m.exec(unit)![1]}s\n`,
        stderr: "",
        termination: "exit",
        signal: null,
        killed: false,
      };
    });
    const preparing = withGatewayServiceUpdateAuthority(
      f.assertCurrent,
      () =>
        withGatewayServiceOperationLock(f.env, async (assertNative) =>
          prepareSystemdGatewayMaintenance({
            state: {
              env: f.env,
              command: f.command,
              installed: true,
              running: true,
              loadState: { status: "loaded" },
              definitionMutationCapability: { kind: "writable" },
            },
            root: "/candidate",
            stopping: true,
            assertCurrent: () => {
              f.assertCurrent();
              assertNative();
            },
            warn: () => {},
          }),
        ),
      { originalRoot: "/old", nativeCommand: runner },
    );
    if (revoked) {
      await expect(preparing).rejects.toThrow("expired authority");
      expect(commands.some((argv) => argv.includes("daemon-reload"))).toBe(false);
      expect(await fs.readFile(f.sourcePath, "utf8")).toBe(original);
    } else {
      await expect(preparing).resolves.toBe(true);
      expect(commands.some((argv) => argv.includes("daemon-reload"))).toBe(true);
      expect(await fs.readFile(f.sourcePath, "utf8")).toContain("TimeoutStopSec=330");
    }
    expect(roots).toEqual(expect.arrayContaining(["/candidate", "/old"]));
    expect(runner).toHaveBeenCalled();
    expect(unowned).not.toHaveBeenCalled();
  },
);

it.each([
  "refresh",
  "offline",
  "reload-failed",
  "reload-unsettled",
  "nonstop-reload-unsettled",
  "override",
  "current-override",
  "unavailable",
  "nonstop-override",
  "current-nonstop-override",
])("protects maintenance with a real legacy unit and preserved drop-in: %s", async (scenario) => {
  const f = await fixture("linux");
  f.command.environment = {
    ...f.command.environment,
    OPENCLAW_SERVICE_MARKER: "openclaw",
    OPENCLAW_SERVICE_KIND: "gateway",
    OPENCLAW_SERVICE_VERSION: "2026.7.1-2",
    PATH: "/usr/bin:/bin",
  };
  const stopping = ![
    "offline",
    "nonstop-override",
    "current-nonstop-override",
    "nonstop-reload-unsettled",
  ].includes(scenario);
  const unsettled = scenario.endsWith("reload-unsettled");
  const cleanupError = new CommandProcessCleanupError();
  const original = buildSystemdUnit(f.command).replace(
    "TimeoutStopSec=330",
    scenario.startsWith("current-") ? "TimeoutStopSec=330" : "TimeoutStopSec=30",
  );
  await fs.writeFile(f.sourcePath, original);
  await fs.writeFile(`${f.sourcePath}.bak`, "previous backup\n", { mode: 0o600 });
  const dropIn = `${f.sourcePath}.d/operator.conf`;
  const unsafeOverride = scenario.includes("override");
  const override = `[Service]\nEnvironment=PATH=/operator/bin:/usr/bin\n${unsafeOverride ? "TimeoutStopSec=30\n" : ""}`;
  await fs.mkdir(path.dirname(dropIn), { mode: 0o700 });
  await fs.writeFile(dropIn, override, { mode: 0o600 });
  f.command.definitionPaths!.push(dropIn);
  let managerTimeout = 30;
  let reloads = 0;
  const operations: string[] = [];
  native.identity.mockImplementation(async (executable, args) => {
    if (executable !== "systemctl") {
      return { code: 0, stdout: "", stderr: "", termination: "exit" };
    }
    if (args.includes("daemon-reload")) {
      operations.push("reload");
      reloads++;
      const backups = await fs.readdir(path.dirname(f.sourcePath));
      expect(backups.some((file) => file.includes(".reconcile-") && file.endsWith(".bak"))).toBe(
        true,
      );
      if (unsettled) {
        throw cleanupError;
      }
      if (scenario === "reload-failed" && reloads === 1) {
        return { code: 1, stdout: "", stderr: "injected reload failure", termination: "exit" };
      }
      const unit = await fs.readFile(f.sourcePath, "utf8");
      managerTimeout = unsafeOverride ? 30 : Number(/^TimeoutStopSec=(\d+)$/m.exec(unit)![1]);
      return { code: 0, stdout: "", stderr: "", termination: "exit" };
    }
    operations.push("show");
    return {
      code: scenario === "unavailable" ? 1 : 0,
      stdout: `LoadState=loaded\nAfter=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nTimeoutStopUSec=${managerTimeout}s\n`,
      stderr: "",
      termination: "exit",
    };
  });
  const warnings: string[] = [];
  const prepare = () =>
    withGatewayServiceOperationLock(f.env, async (assertNative) =>
      prepareSystemdGatewayMaintenance({
        state: {
          env: f.env,
          command: f.command,
          installed: true,
          running: scenario !== "offline",
          loadState: { status: "loaded" },
          definitionMutationCapability: { kind: "writable" },
        },
        root: "/old",
        stopping,
        assertCurrent: () => {
          f.assertCurrent();
          assertNative();
        },
        warn: (message) => warnings.push(message),
      }),
    );
  if (unsettled) {
    await expect(prepare()).rejects.toBe(cleanupError);
    expect(reloads).toBe(1);
    expect(operations.at(-1)).toBe("reload");
    expect(warnings.join(" ")).not.toContain("refresh skipped");
    const backups = await fs.readdir(path.dirname(f.sourcePath));
    expect(backups.some((file) => file.includes(".reconcile-") && file.endsWith(".bak"))).toBe(
      true,
    );
  } else if (scenario !== "reload-failed") {
    const refreshRequired = scenario !== "current-nonstop-override";
    expect(await prepare()).toBe(refreshRequired);
    expect(managerTimeout).toBe(unsafeOverride ? 30 : GATEWAY_SERVICE_STOP_TIMEOUT_MS / 1_000);
    expect(reloads).toBe(refreshRequired ? 1 : 0);
    if (refreshRequired) {
      expect(operations).toContain("reload");
      expect(warnings.join(" ")).toContain(
        scenario === "current-override"
          ? "Refreshed Gateway service definition"
          : "Service.TimeoutStopSec",
      );
    }
    if (!stopping && unsafeOverride) {
      expect(warnings.join(" ")).toMatch(/effective.*30000ms.*330s.*operator overrides/i);
      expect(operations.at(-1)).toBe("show");
    }
    if (scenario === "unavailable") {
      expect(
        await readSystemdGatewayStopTimeout({
          env: f.env,
          command: f.command,
          installed: true,
          running: true,
          loadState: { status: "loaded" },
        }),
      ).toBeUndefined();
    }
    expect(await fs.readFile(f.sourcePath, "utf8")).toContain("TimeoutStartSec=30");
  } else {
    expect(await prepare()).toBe(false);
    expect(warnings.join(" ")).toContain("refresh skipped");
    expect(await fs.readFile(f.sourcePath, "utf8")).toBe(original);
    expect(managerTimeout).toBe(30);
    expect(reloads).toBe(2);
    if (scenario === "reload-failed") {
      expect(warnings.join(" ")).toContain("previous definition was restored");
    }
  }
  expect(await fs.readFile(dropIn, "utf8")).toBe(override);
  expect(await fs.readFile(`${f.sourcePath}.bak`, "utf8")).toBe("previous backup\n");
});

it.each([
  { stopping: false, stopSeconds: 30 },
  { stopping: true, stopSeconds: 30 },
  { stopping: false, stopSeconds: 600 },
  { stopping: true, stopSeconds: 600 },
])(
  "refreshes native budgets while retaining custom values ($stopSeconds, stopping=$stopping)",
  async ({ stopping, stopSeconds }) => {
    const f = await fixture("linux");
    f.command.environment = {
      ...f.command.environment,
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
      OPENCLAW_SERVICE_VERSION: "2026.7.1-2",
      PATH: "/usr/bin:/bin",
    };
    const original = buildSystemdUnit(f.command)
      .replace("TimeoutStartSec=30", "TimeoutStartSec=45")
      .replace("TimeoutStopSec=330", `TimeoutStopSec=${stopSeconds}`)
      .replace("KillMode=mixed", "KillMode=control-group");
    await fs.writeFile(f.sourcePath, original);
    let loadedStop = stopSeconds;
    native.identity.mockImplementation(async (_command, args) => {
      if (args.includes("daemon-reload")) {
        loadedStop = stopSeconds === 30 ? 330 : stopSeconds;
      }
      return {
        code: 0,
        stdout: `LoadState=loaded\nAfter=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nTimeoutStopUSec=${loadedStop}s\n`,
        stderr: "",
        termination: "exit",
      };
    });
    const warnings: string[] = [];
    const result = await withGatewayServiceOperationLock(f.env, async (assertCurrent) =>
      prepareSystemdGatewayMaintenance({
        state: {
          env: f.env,
          command: f.command,
          installed: true,
          running: true,
          loadState: { status: "loaded" },
          definitionMutationCapability: { kind: "writable" },
        },
        root: "/old",
        stopping,
        assertCurrent,
        warn: (warning) => warnings.push(warning),
      }),
    );
    expect(result).toBe(true);
    const refreshed = await fs.readFile(f.sourcePath, "utf8");
    expect(refreshed).toContain("TimeoutStartSec=45");
    expect(refreshed).toContain(`TimeoutStopSec=${stopSeconds === 30 ? 330 : stopSeconds}`);
    expect(refreshed).toContain("KillMode=mixed");
    expect(warnings.join(" ")).toContain("Service.TimeoutStartSec");
    expect(warnings.join(" ")).toContain("not changed");
    expect(native.identity.mock.calls.some(([, args]) => args.includes("daemon-reload"))).toBe(
      true,
    );
  },
);
