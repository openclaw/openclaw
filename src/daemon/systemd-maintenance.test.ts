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
import { nativeExit } from "./systemd-exec.test-support.js";
import { prepareSystemdGatewayMaintenance } from "./systemd-maintenance.js";
import * as systemdScope from "./systemd-scope.js";
import { readSystemdGatewayStopTimeout } from "./systemd-stop-policy.js";
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
  return nativeExit(
    `LoadState=loaded\nAfter=network-online.target\nWants=network-online.target\nRestartUSec=5s\nKillMode=mixed\nTimeoutStopUSec=${stopSeconds}s\n`,
    "",
    code,
  );
}
function prepare(
  f: PolicyFixture,
  options: {
    stopping: boolean;
    root?: string;
    state?: Parameters<typeof prepareSystemdGatewayMaintenance>[0]["state"];
  },
) {
  return withGatewayServiceOperationLock(f.env, async (assertNative) =>
    prepareSystemdGatewayMaintenance({
      state: options.state ?? installedState(f),
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
  const runner = vi.fn<GatewayServiceNativeCommand>(async () => {
    expect(readGatewayServiceUpdateOriginalRoot()).toBe("/old");
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
    expect(runner.mock.calls.some(([argv]) => argv.includes("daemon-reload"))).toBe(false);
    expect(await f.read()).toBe(f.original);
  } else {
    await expect(preparing).resolves.toEqual({ kind: "refreshed" });
    expect(runner.mock.calls.some(([argv]) => argv.includes("daemon-reload"))).toBe(true);
    expect(await f.read()).toContain("TimeoutStopSec=330");
  }
  expect(roots).toEqual(expect.arrayContaining(["/candidate", "/old"]));
  expect(unowned).not.toHaveBeenCalled();
});

it.each([
  "refresh",
  "repairable",
  "reload-failed",
  "reload-unsettled",
  "nonstop-reload-unsettled",
  "override",
  "current-override",
  "unavailable",
  "nonstop-override",
  "current-nonstop-override",
  "custom",
  "custom-nonstop",
  "current",
  "current-nonstop",
])("preserves legacy unit drop-ins: %s", async (scenario) => {
  const custom = scenario.startsWith("custom");
  const stopSeconds = scenario === "custom" ? 600 : scenario.startsWith("current") ? 330 : 30;
  const f = await policyFixture(stopSeconds);
  const { warnings } = f;
  const original = custom
    ? f.original
        .replace("TimeoutStartSec=30", "TimeoutStartSec=45")
        .replace("KillMode=mixed", "KillMode=control-group")
    : f.original;
  if (custom) {
    await fs.writeFile(f.sourcePath, original);
  }
  const stopping = !scenario.includes("nonstop");
  const unsettled = scenario.endsWith("reload-unsettled");
  const cleanupError = new CommandProcessCleanupError();
  if (scenario === "repairable") {
    await fs.chmod(f.sourcePath, 0o664);
  }
  await fs.writeFile(`${f.sourcePath}.bak`, "previous backup\n", { mode: 0o600 });
  const dropIn = `${f.sourcePath}.d/operator.conf`;
  const hasDropIn = !["current", "current-nonstop"].includes(scenario);
  const unsafeOverride = scenario.includes("override");
  const override = `[Service]\nEnvironment=PATH=/operator/bin:/usr/bin\n${unsafeOverride ? "TimeoutStopSec=30\n" : ""}`;
  if (hasDropIn) {
    await fs.mkdir(path.dirname(dropIn), { mode: 0o700 });
    await fs.writeFile(dropIn, override, { mode: 0o600 });
    f.command.definitionPaths!.push(dropIn);
  }
  let managerTimeout = scenario.includes("override") ? 30 : stopSeconds;
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
  const run = () => prepare(f, { stopping });
  if (unsettled) {
    await expect(run()).rejects.toBe(cleanupError);
    expect(reloads).toBe(1);
    expect(operations.at(-1)).toBe("reload");
    expect(await hasBackup(f)).toBe(true);
  } else if (scenario !== "reload-failed") {
    const refreshRequired = !scenario.startsWith("current") || (stopping && unsafeOverride);
    expect(await run()).toEqual({ kind: refreshRequired ? "refreshed" : "unchanged" });
    expect(managerTimeout).toBe(
      unsafeOverride ? 30 : Math.max(stopSeconds, GATEWAY_SERVICE_STOP_TIMEOUT_MS / 1_000),
    );
    expect(reloads).toBe(refreshRequired ? 1 : 0);
    if (scenario === "repairable") {
      expect((await fs.stat(f.sourcePath)).mode & 0o777).toBe(0o600);
    }
    if (!stopping && unsafeOverride) {
      expect(warnings.join(" ")).toMatch(/effective.*30000ms.*330s.*operator overrides/i);
      expect(operations.at(-1)).toBe("show");
    }
    if (scenario === "unavailable") {
      expect(await readSystemdGatewayStopTimeout(installedState(f))).toBeUndefined();
    }
    const refreshed = await f.read();
    expect(refreshed).toContain(`TimeoutStartSec=${custom ? 45 : 30}`);
    if (custom) {
      expect(refreshed).toContain("KillMode=mixed");
      expect(warnings.join(" ")).toContain("not changed");
    }
  } else {
    expect(await run()).toEqual({ kind: "failed" });
    expect(warnings.join(" ")).toContain("refresh skipped");
    expect(await f.read()).toBe(original);
    expect(managerTimeout).toBe(30);
    expect(reloads).toBe(2);
  }
  if (hasDropIn) {
    expect(await fs.readFile(dropIn, "utf8")).toBe(override);
  }
  expect(await fs.readFile(`${f.sourcePath}.bak`, "utf8")).toBe("previous backup\n");
});

it.each(["selected sealed", "removed", "live"] as const)(
  "rechecks system ownership: %s",
  async (owner) => {
    const selected = owner === "selected sealed";
    const live = owner === "live";
    const f = await policyFixture(selected ? 330 : 30);
    native.identity.mockResolvedValue(nativeResult(selected ? 330 : 30));
    if (live) {
      vi.spyOn(systemdScope, "assertNoSystemGatewayOwnership").mockRejectedValue(
        new Error("A live system unit owns this Gateway"),
      );
    }
    const state = {
      ...installedState(f, selected),
      definitionMutationCapability: { kind: "sealed", reason: "system-owned" } as const,
    };
    if (selected) {
      expect(
        await readSystemdGatewayStopTimeout({
          ...state,
          systemdInstallation: {
            kind: "system",
            system: {
              scope: "system",
              unitName: "openclaw.service",
              unitPath: "/etc/systemd/system/openclaw.service",
            },
          },
        }),
      ).toBe(330_000);
      expect(native.identity.mock.calls.at(-1)?.[1]).toEqual([
        "show",
        "openclaw.service",
        "--no-page",
        "--property",
        "LoadState,TimeoutStopUSec",
      ]);
      expect(native.transport).not.toHaveBeenCalled();
    } else {
      expect(await prepare(f, { stopping: false, state })).toEqual({
        kind: live ? "failed" : "refreshed",
      });
      expect(await f.read()).toContain(`TimeoutStopSec=${live ? 30 : 330}`);
      if (live) {
        expect(f.warnings.join(" ")).toContain("A live system unit owns this Gateway");
      }
    }
  },
);
