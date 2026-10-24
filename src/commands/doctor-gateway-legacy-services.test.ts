import fs from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ExtraGatewayService, GatewayServiceInventory } from "../daemon/inspect.js";
import type { LaunchctlResult } from "../daemon/launchd-exec.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  makeDoctorIo,
  makeDoctorPrompts,
  pinSnapshotMock,
} from "./doctor-gateway-runtime.test-utils.js";
import {
  detectExtraGatewayServiceIssues,
  maybeScanExtraGatewayServices,
} from "./doctor-gateway-services.js";
import {
  mocks,
  mockProcessPlatform,
  expectNoteContaining,
  expectNoNoteContaining,
} from "./doctor-gateway-services.native.test-support.js";
import { formatServiceRepairDeferredNote } from "./doctor-service-repair-policy.js";

await vi.hoisted(() => import("./doctor-gateway-services.native.test-support.js"));

const originalPlatform = process.platform;

const LEGACY_MAC_LABEL = "com.openclaw.gateway";
const LEGACY_MAC_PLIST = "/Users/test/Library/LaunchAgents/com.openclaw.gateway.plist";

function inventory(
  services: ExtraGatewayService[],
  errors: GatewayServiceInventory["errors"] = [],
) {
  mocks.findExtraGatewayServices.mockResolvedValue({ services, errors });
}
function fileService(
  platform: "darwin" | "linux",
  label: string,
  scope: "user" | "system" = "user",
  legacy = false,
): ExtraGatewayService {
  const directory =
    platform === "darwin"
      ? "/Users/test/Library/LaunchAgents"
      : scope === "user"
        ? "/home/test/.config/systemd/user"
        : "/etc/systemd/system";
  const sourcePath = `${directory}/${label}${platform === "darwin" ? ".plist" : ""}`;
  return { platform, label, sourcePath, detail: sourcePath, scope, legacy };
}

function setupLegacyMacService() {
  mockProcessPlatform("darwin");
  inventory([fileService("darwin", LEGACY_MAC_LABEL, "user", true)]);
}
async function scan(deep = false, runtime = makeDoctorIo(), prompts = makeDoctorPrompts()) {
  await maybeScanExtraGatewayServices({ deep }, runtime, prompts);
}
async function useRealCleanupHints() {
  const actual =
    await vi.importActual<typeof import("../daemon/inspect.js")>("../daemon/inspect.js");
  mocks.renderGatewayServiceCleanupHints.mockImplementation(
    actual.renderGatewayServiceCleanupHints,
  );
}
function mockPlistFs() {
  return {
    mkdir: vi.spyOn(fs, "mkdir").mockResolvedValue(undefined),
    access: vi.spyOn(fs, "access").mockResolvedValue(undefined),
    rename: vi.spyOn(fs, "rename").mockResolvedValue(undefined),
  };
}
function expectNoInstall(runtime: ReturnType<typeof makeDoctorIo>) {
  expect(runtime.log).not.toHaveBeenCalledWith(
    expect.stringContaining("Installing OpenClaw gateway next."),
  );
}

function launchctlResult(params: Partial<LaunchctlResult> = {}): LaunchctlResult {
  return { stdout: "", stderr: "", code: 0, termination: "exit", ...params };
}

function expectBoundedLaunchctlCleanup() {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  expect(mocks.execLaunchctl.mock.calls.slice(0, 3)).toEqual([
    [["bootout", domain, LEGACY_MAC_PLIST], 5_000],
    [["unload", LEGACY_MAC_PLIST], 5_000],
    [["print", `${domain}/${LEGACY_MAC_LABEL}`], expect.any(Number)],
  ]);
  const probeTimeout = mocks.execLaunchctl.mock.calls[2]?.[1];
  expect(probeTimeout).toBeGreaterThan(0);
  expect(probeTimeout).toBeLessThanOrEqual(5_000);
}

beforeEach(() => {
  pinSnapshotMock.mockReset().mockReturnValue({ revision: "empty", stored: false });
  vi.clearAllMocks();
  mocks.writeConfig.mockReset().mockImplementation(async (nextConfig) => nextConfig);
  mocks.isContainerEnvironment.mockReturnValue(false);
  mocks.findExtraGatewayServices.mockResolvedValue({ services: [], errors: [] });
  mocks.renderGatewayServiceCleanupHints.mockReturnValue([]);
  mocks.isSystemdUnitActive.mockResolvedValue(ok(false));
  mocks.uninstallLegacySystemdUnits.mockResolvedValue([]);
  mocks.execLaunchctl.mockReset().mockResolvedValue(launchctlResult());
});

afterEach(() => {
  vi.restoreAllMocks();
  mockProcessPlatform(originalPlatform);
});

it.each([
  ["inactive", ok(false), "user", false],
  ["active", ok(true), "system", true],
  ["unknown", err("Failed to connect to bus: Permission denied"), "system", true],
] satisfies [string, Result<boolean, string>, "user" | "system", boolean][])(
  "reports non-legacy Linux services with %s activity",
  async (_, active, scope, reported) => {
    mockProcessPlatform("linux");
    await useRealCleanupHints();
    const service = fileService("linux", "custom-gateway.service", scope);
    inventory(
      [service],
      [
        {
          source: "/etc/systemd/system/openclaw-unreadable.service",
          message: "Service path could not be inspected.",
        },
      ],
    );
    mocks.isSystemdUnitActive.mockResolvedValue(active);
    await scan();
    expect(mocks.isSystemdUnitActive).toHaveBeenCalledWith(
      process.env,
      "custom-gateway.service",
      scope,
    );
    expectNoteContaining("openclaw-unreadable.service", "Gateway service inspection incomplete");
    if (reported) {
      expectNoteContaining("custom-gateway.service", "Other gateway-like services detected");
      expect(mocks.renderGatewayServiceCleanupHints).toHaveBeenCalledWith([service]);
      for (const command of ["status", "cat"]) {
        expectNoteContaining(
          `systemctl --${scope} ${command} -- custom-gateway.service`,
          "Inspection hints",
        );
      }
      expectNoNoteContaining(`rm ${service.sourcePath}`, "Cleanup hints");
    } else {
      expectNoNoteContaining("custom-gateway.service", "Other gateway-like services detected");
    }
    expect(mocks.uninstallLegacySystemdUnits).not.toHaveBeenCalled();
  },
);

it("keeps Windows Node diagnostics with inspection advice", async () => {
  mockProcessPlatform("win32");
  await useRealCleanupHints();
  inventory([
    {
      platform: "win32",
      label: "\\OpenClaw Node",
      detail: "task: \\OpenClaw Node, run: C:\\OpenClaw\\openclaw.exe node run",
      scope: "system",
      legacy: false,
    },
  ]);
  await scan(true);
  expectNoteContaining("\\OpenClaw Node", "Other gateway-like services detected");
  expectNoteContaining('schtasks /Query /TN "\\OpenClaw Node" /V /FO LIST', "Inspection hints");
  expectNoNoteContaining("/Delete", "Cleanup hints");
  expect(mocks.uninstallLegacySystemdUnits).not.toHaveBeenCalled();
  expect(mocks.execLaunchctl).not.toHaveBeenCalled();
});

it.each([false, true])("limits macOS cleanup hints to non-legacy extras (%s)", async (legacy) => {
  mockProcessPlatform("darwin");
  const extraService = fileService("darwin", "com.example.openclaw-gateway", "user", legacy);
  inventory([extraService]);
  mocks.renderGatewayServiceCleanupHints.mockReturnValue(
    legacy
      ? []
      : [
          "launchctl bootout gui/$UID/com.example.openclaw-gateway",
          "rm /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
        ],
  );
  await scan(false, undefined, {
    ...makeDoctorPrompts(),
    confirmRuntimeRepair: vi.fn().mockResolvedValue(false),
  });
  expect(mocks.renderGatewayServiceCleanupHints).toHaveBeenCalledWith(legacy ? [] : [extraService]);
  if (!legacy) {
    expectNoteContaining("com.example.openclaw-gateway", "Cleanup hints");
  }
  expectNoNoteContaining("ai.openclaw.gateway", "Cleanup hints");
});

it("reports incomplete inspection without offering unverified cleanup", async () => {
  mockProcessPlatform("darwin");
  const source = "/Users/test/Library/LaunchAgents/ai.openclaw.backup.plist";
  inventory([], [{ source, message: "Service plist could not be inspected." }]);
  const prompts = makeDoctorPrompts();
  await scan(true, undefined, prompts);
  expect(mocks.findExtraGatewayServices).toHaveBeenCalledWith(process.env, { deep: true });
  expectNoteContaining(source, "Gateway service inspection incomplete");
  expectNoteContaining("could not be inspected", "Gateway service inspection incomplete");
  expect(mocks.renderGatewayServiceCleanupHints).not.toHaveBeenCalled();
  expect(prompts.confirmRuntimeRepair).not.toHaveBeenCalled();
  expect(mocks.execLaunchctl).not.toHaveBeenCalled();
  expect(mocks.uninstallLegacySystemdUnits).not.toHaveBeenCalled();
});

it("skips host-service discovery in containers without an OpenClaw service", async () => {
  mocks.isContainerEnvironment.mockReturnValue(true);
  await expect(detectExtraGatewayServiceIssues({ deep: true })).resolves.toEqual({
    services: [],
    errors: [],
  });
  expect(mocks.findExtraGatewayServices).not.toHaveBeenCalled();
  expect(mocks.isSystemdUnitActive).not.toHaveBeenCalled();
});

it.each(["recognized", "unsupported", "external"])(
  "handles %s legacy Linux services without unrelated cleanup",
  async (kind) => {
    mockProcessPlatform("linux");
    const label =
      kind === "unsupported" ? "clawdbot-gateway-custom.service" : "clawdbot-gateway.service";
    inventory([fileService("linux", label, "user", true)]);
    mocks.uninstallLegacySystemdUnits.mockResolvedValue([
      {
        name: "clawdbot-gateway",
        unitPath: "/home/test/.config/systemd/user/clawdbot-gateway.service",
      },
    ]);
    const runtime = makeDoctorIo();
    await withEnvAsync(
      { OPENCLAW_SERVICE_REPAIR_POLICY: kind === "external" ? "external" : undefined },
      () => scan(false, runtime),
    );
    expectNoteContaining(label, "Other gateway-like services detected");
    if (kind === "recognized") {
      expect(mocks.uninstallLegacySystemdUnits).toHaveBeenCalledExactlyOnceWith({
        env: process.env,
        stdout: process.stdout,
      });
      expectNoteContaining(label, "Legacy gateway removed");
    } else {
      expect(mocks.uninstallLegacySystemdUnits).not.toHaveBeenCalled();
      expect(mocks.note.mock.calls.some(([, title]) => title === "Legacy gateway removed")).toBe(
        false,
      );
      if (kind === "external") {
        expect(mocks.note).toHaveBeenCalledWith(
          formatServiceRepairDeferredNote("external"),
          "Legacy gateway cleanup skipped",
        );
      } else {
        expectNoteContaining(
          `${label} (legacy unit name not recognized)`,
          "Legacy gateway cleanup skipped",
        );
      }
    }
    expectNoInstall(runtime);
  },
);

const absent = launchctlResult({ code: 113, stderr: "Could not find service" });
const stopped = launchctlResult({ stdout: "state = waiting\npid = 0\n" });
const timeout = launchctlResult({ code: 124, termination: "timeout" });
const denied = launchctlResult({ code: 1, stderr: "Permission denied" });
const sequence = (...probes: LaunchctlResult[]) => [
  launchctlResult(),
  launchctlResult(),
  ...probes,
];
const reasons = {
  inspect: "could not inspect plist",
  move: "could not move plist",
  unload: "launchctl could not confirm unload",
};
it.each<[string, LaunchctlResult[], ("absent" | keyof typeof reasons)?]>([
  ["missing service", sequence(absent)],
  ["missing process", sequence(launchctlResult({ code: 113, stderr: "No such process" }))],
  ["registered stopped label", sequence(stopped, absent)],
  ["absent plist", sequence(absent), "absent"],
  ["uninspectable plist", sequence(absent), "inspect"],
  ["unmovable plist", sequence(absent), "move"],
  ["timeouts", [timeout, timeout, timeout], "unload"],
  ["unknown failures", [denied, denied, denied], "unload"],
  ["loaded probe after successful unload", [timeout, launchctlResult(), stopped, denied], "unload"],
])("settles legacy macOS cleanup for %s", async (_, outcomes, failure) => {
  setupLegacyMacService();
  for (const result of outcomes) {
    mocks.execLaunchctl.mockResolvedValueOnce(result);
  }
  const { mkdir, access, rename } = mockPlistFs();
  if (failure === "absent" || failure === "inspect") {
    const code = failure === "absent" ? "ENOENT" : "EACCES";
    access.mockRejectedValue(Object.assign(new Error(code), { code }));
  }
  if (failure === "move") {
    rename.mockRejectedValue(new Error("permission denied"));
  }
  const runtime = makeDoctorIo();
  await scan(false, runtime);
  expectBoundedLaunchctlCleanup();
  expect(mocks.execLaunchctl).toHaveBeenCalledTimes(outcomes.length);
  if (failure === "unload") {
    for (const operation of [mkdir, access, rename]) {
      expect(operation).not.toHaveBeenCalled();
    }
    expect(runtime.log).not.toHaveBeenCalledWith(
      "Legacy gateway services removed. Installing OpenClaw gateway next.",
    );
  } else {
    expect(rename).toHaveBeenCalledTimes(failure === "absent" || failure === "inspect" ? 0 : 1);
    expectNoInstall(runtime);
  }
  if (failure && failure !== "absent") {
    expectNoteContaining(
      `${LEGACY_MAC_LABEL} (${reasons[failure]})`,
      "Legacy gateway cleanup skipped",
    );
    expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
  } else {
    expectNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
    expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway cleanup skipped");
  }
});

it.skipIf(process.platform === "win32").each([false, true])(
  "uses real command outcomes for legacy cleanup (signal=%s)",
  async (signal) => {
    setupLegacyMacService();
    const actual = await vi.importActual<typeof import("../daemon/launchd-exec.js")>(
      "../daemon/launchd-exec.js",
    );
    mocks.execLaunchctl.mockImplementation(actual.execLaunchctl);
    await withTempDir("openclaw-doctor-launchctl-", async (dir) => {
      await fs.writeFile(
        path.join(dir, "launchctl"),
        `#!/bin/sh\nif [ "$1" = print ]; then\n  printf 'Could not find service\\n' >&2\n  ${signal ? "kill -TERM $$" : "exit 113"}\nfi\nexit 0\n`,
        { mode: 0o700 },
      );
      const { rename } = mockPlistFs();
      await withEnvAsync({ PATH: dir }, async () => {
        await scan();
      });
      expect(rename).toHaveBeenCalledTimes(signal ? 0 : 1);
      expectNoteContaining(
        LEGACY_MAC_LABEL,
        signal ? "Legacy gateway cleanup skipped" : "Legacy gateway removed",
      );
    });
  },
);
