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
import * as systemdScope from "./systemd-scope.js";
import { buildSystemdUnit } from "./systemd-unit.js";

vi.mock("./service-layout.js", async (original) => ({
  ...(await original<typeof import("./service-layout.js")>()),
  gatewayServiceCommandMatchesRoot: async () => true,
}));

async function policyFixture(stopSeconds = 330, includePath = true) {
  const f = await fixture("linux");
  f.command.environment = {
    ...f.command.environment,
    OPENCLAW_SERVICE_MARKER: "openclaw",
    OPENCLAW_SERVICE_KIND: "gateway",
    OPENCLAW_SERVICE_VERSION: "2026.7.1-2",
    ...(includePath ? { PATH: "/usr/bin:/bin" } : {}),
  };
  const original = buildSystemdUnit(f.command).replace(
    "TimeoutStopSec=330",
    `TimeoutStopSec=${stopSeconds}`,
  );
  await fs.writeFile(f.sourcePath, original);
  const warnings: string[] = [];
  return {
    ...f,
    original,
    warnings,
    read: () => fs.readFile(f.sourcePath, "utf8"),
    warn: (message: string) => warnings.push(message),
  };
}

function installedState(f: Awaited<ReturnType<typeof policyFixture>>, running = true) {
  return {
    env: f.env,
    command: f.command,
    installed: true,
    running,
    loadState: { status: "loaded" as const },
    definitionMutationCapability: { kind: "writable" as const },
  };
}
type PolicyFixture = Awaited<ReturnType<typeof policyFixture>>;
function nativeResult(stopSeconds: number, code = 0) {
  return {
    code,
    termination: "exit" as const,
    stderr: "",
    stdout: `LoadState=loaded\nAfter=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nTimeoutStopUSec=${stopSeconds}s\n`,
  };
}
function prepare(
  f: PolicyFixture,
  options: {
    stopping: boolean;
    running?: boolean;
    root?: string;
    state?: ReturnType<typeof installedState>;
  },
) {
  return withGatewayServiceOperationLock(f.env, async (assertNative) =>
    prepareSystemdGatewayMaintenance({
      state: options.state ?? installedState(f, options.running),
      root: options.root ?? "/old",
      stopping: options.stopping,
      warn: f.warn,
      assertCurrent: () => {
        f.assertCurrent();
        assertNative();
      },
    }),
  );
}
const hasReload = () =>
  native.identity.mock.calls.some(([, args]) => args.includes("daemon-reload"));
const hasBackup = async (f: PolicyFixture) =>
  (await fs.readdir(path.dirname(f.sourcePath))).some(
    (file) => file.includes(".reconcile-") && file.endsWith(".bak"),
  );

it.each([false, true])("retains native runner and owner (revoked=%s)", async (revoked) => {
  const f = await policyFixture(30, false);
  const unowned = vi
    .spyOn(commandExec, "runCommandWithTimeout")
    .mockRejectedValue(new Error("unowned native fallback"));
  const { execFileUtf8 } = await vi.importActual<typeof import("./exec-file.js")>("./exec-file.js");
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
    const unit = await f.read();
    return {
      ...nativeResult(Number(/^TimeoutStopSec=(\d+)$/m.exec(unit)![1])),
      signal: null,
      killed: false,
    };
  });
  const preparing = withGatewayServiceUpdateAuthority(
    f.assertCurrent,
    () => prepare(f, { root: "/candidate", stopping: true }),
    { originalRoot: "/old", nativeCommand: runner },
  );
  if (revoked) {
    await expect(preparing).rejects.toThrow("expired authority");
    expect(commands.some((argv) => argv.includes("daemon-reload"))).toBe(false);
    expect(await f.read()).toBe(f.original);
  } else {
    await expect(preparing).resolves.toEqual({ kind: "refreshed" });
    expect(commands.some((argv) => argv.includes("daemon-reload"))).toBe(true);
    expect(await f.read()).toContain("TimeoutStopSec=330");
  }
  expect(roots).toEqual(expect.arrayContaining(["/candidate", "/old"]));
  expect(runner).toHaveBeenCalled();
  expect(unowned).not.toHaveBeenCalled();
});

it.each([
  "refresh",
  "repairable",
  "offline",
  "reload-failed",
  "reload-unsettled",
  "nonstop-reload-unsettled",
  "override",
  "current-override",
  "unavailable",
  "nonstop-override",
  "current-nonstop-override",
])("preserves legacy unit drop-ins: %s", async (scenario) => {
  const f = await policyFixture(scenario.startsWith("current-") ? 330 : 30);
  const { original, warnings } = f;
  const stopping = ![
    "offline",
    "nonstop-override",
    "current-nonstop-override",
    "nonstop-reload-unsettled",
  ].includes(scenario);
  const unsettled = scenario.endsWith("reload-unsettled");
  const cleanupError = new CommandProcessCleanupError();
  if (scenario === "repairable") {
    await fs.chmod(f.sourcePath, 0o664);
  }
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
      expect(await hasBackup(f)).toBe(true);
      if (unsettled) {
        throw cleanupError;
      }
      if (scenario === "reload-failed" && reloads === 1) {
        return { code: 1, stdout: "", stderr: "injected reload failure", termination: "exit" };
      }
      const unit = await f.read();
      managerTimeout = unsafeOverride ? 30 : Number(/^TimeoutStopSec=(\d+)$/m.exec(unit)![1]);
      return { code: 0, stdout: "", stderr: "", termination: "exit" };
    }
    operations.push("show");
    return nativeResult(managerTimeout, scenario === "unavailable" ? 1 : 0);
  });
  const run = () => prepare(f, { running: scenario !== "offline", stopping });
  if (unsettled) {
    await expect(run()).rejects.toBe(cleanupError);
    expect(reloads).toBe(1);
    expect(operations.at(-1)).toBe("reload");
    expect(warnings.join(" ")).not.toContain("refresh skipped");
    expect(await hasBackup(f)).toBe(true);
  } else if (scenario !== "reload-failed") {
    const refreshRequired = scenario !== "current-nonstop-override";
    expect(await run()).toEqual({ kind: refreshRequired ? "refreshed" : "unchanged" });
    expect(managerTimeout).toBe(unsafeOverride ? 30 : GATEWAY_SERVICE_STOP_TIMEOUT_MS / 1_000);
    expect(reloads).toBe(refreshRequired ? 1 : 0);
    if (scenario === "repairable") {
      expect((await fs.stat(f.sourcePath)).mode & 0o777).toBe(0o600);
    }
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
      expect(await readSystemdGatewayStopTimeout(installedState(f))).toBeUndefined();
    }
    expect(await f.read()).toContain("TimeoutStartSec=30");
  } else {
    expect(await run()).toEqual({ kind: "failed" });
    expect(warnings.join(" ")).toContain("refresh skipped");
    expect(await f.read()).toBe(original);
    expect(managerTimeout).toBe(30);
    expect(reloads).toBe(2);
    expect(warnings.join(" ")).toContain("previous definition was restored");
  }
  expect(await fs.readFile(dropIn, "utf8")).toBe(override);
  expect(await fs.readFile(`${f.sourcePath}.bak`, "utf8")).toBe("previous backup\n");
});

it.each([
  { stopping: false, stopSeconds: 30 },
  { stopping: true, stopSeconds: 600 },
])(
  "retains custom budgets ($stopSeconds, stopping=$stopping)",
  async ({ stopping, stopSeconds }) => {
    const f = await policyFixture(stopSeconds);
    const original = f.original
      .replace("TimeoutStartSec=30", "TimeoutStartSec=45")
      .replace("KillMode=mixed", "KillMode=control-group");
    await fs.writeFile(f.sourcePath, original);
    let loadedStop = stopSeconds;
    native.identity.mockImplementation(async (_command, args) => {
      if (args.includes("daemon-reload")) {
        loadedStop = stopSeconds === 30 ? 330 : stopSeconds;
      }
      return nativeResult(loadedStop);
    });
    const result = await prepare(f, { stopping });
    expect(result).toEqual({ kind: "refreshed" });
    const refreshed = await f.read();
    expect(refreshed).toContain("TimeoutStartSec=45");
    expect(refreshed).toContain(`TimeoutStopSec=${stopSeconds === 30 ? 330 : stopSeconds}`);
    expect(refreshed).toContain("KillMode=mixed");
    expect(f.warnings.join(" ")).toContain("Service.TimeoutStartSec");
    expect(f.warnings.join(" ")).toContain("not changed");
    expect(hasReload()).toBe(true);
  },
);

it.each([false, true])("reports current policy as unchanged (stopping: %s)", async (stopping) => {
  const f = await policyFixture();
  native.identity.mockResolvedValue(nativeResult(330));
  const result = await prepareSystemdGatewayMaintenance({
    state: installedState(f, false),
    root: "/old",
    stopping,
    assertCurrent: f.assertCurrent,
    warn: vi.fn(),
  });
  expect(result).toEqual({ kind: "unchanged" });
  expect(hasReload()).toBe(false);
});

it.each([false, true])("rechecks system ownership (live=%s)", async (liveSystemUnit) => {
  const f = await policyFixture(30);
  native.identity.mockResolvedValue(nativeResult(30));
  if (liveSystemUnit) {
    vi.spyOn(systemdScope, "assertNoSystemGatewayOwnership").mockRejectedValue(
      new Error("A live system unit owns this Gateway"),
    );
  }
  const { warnings } = f;
  const result = await withGatewayServiceOperationLock(f.env, async (assertCurrent) =>
    prepareSystemdGatewayMaintenance({
      state: {
        ...installedState(f, false),
        definitionMutationCapability: { kind: "sealed", reason: "system-owned" },
      },
      root: "/old",
      stopping: false,
      assertCurrent,
      warn: f.warn,
    }),
  );
  expect(result).toEqual({ kind: liveSystemUnit ? "failed" : "refreshed" });
  expect(await f.read()).toContain(`TimeoutStopSec=${liveSystemUnit ? 30 : 330}`);
  expect(warnings.join(" ")).not.toContain("SERVICE_DEFINITION_SEALED");
  if (liveSystemUnit) {
    expect(warnings.join(" ")).toContain("A live system unit owns this Gateway");
  }
});
