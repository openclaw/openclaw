import fs from "node:fs/promises";
import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function setupLegacyMacService() {
  mockProcessPlatform("darwin");
  mocks.findExtraGatewayServices.mockResolvedValue({
    services: [
      {
        platform: "darwin",
        label: LEGACY_MAC_LABEL,
        detail: `plist: ${LEGACY_MAC_PLIST}`,
        sourcePath: LEGACY_MAC_PLIST,
        scope: "user",
        legacy: true,
      },
    ],
    errors: [],
  });
}

function launchctlResult(params: Partial<LaunchctlResult> = {}): LaunchctlResult {
  return { stdout: "", stderr: "", code: 0, termination: "exit", ...params };
}

function expectBoundedLaunchctlCleanup() {
  const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
  expect(mocks.execLaunchctl).toHaveBeenNthCalledWith(
    1,
    ["bootout", domain, LEGACY_MAC_PLIST],
    5_000,
  );
  expect(mocks.execLaunchctl).toHaveBeenNthCalledWith(2, ["unload", LEGACY_MAC_PLIST], 5_000);
  expect(mocks.execLaunchctl).toHaveBeenNthCalledWith(
    3,
    ["print", `${domain}/${LEGACY_MAC_LABEL}`],
    expect.any(Number),
  );
  const probeTimeout = mocks.execLaunchctl.mock.calls[2]?.[1];
  expect(probeTimeout).toBeGreaterThan(0);
  expect(probeTimeout).toBeLessThanOrEqual(5_000);
}

describe("maybeScanExtraGatewayServices", () => {
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
    "reports non-legacy Linux gateway-like services with %s activity only when appropriate",
    async (_, active, scope, reported) => {
      mockProcessPlatform("linux");
      const { renderGatewayServiceCleanupHints } =
        await vi.importActual<typeof import("../daemon/inspect.js")>("../daemon/inspect.js");
      mocks.renderGatewayServiceCleanupHints.mockImplementation(renderGatewayServiceCleanupHints);
      const unitPath = `${scope === "user" ? "/home/test/.config/systemd/user" : "/etc/systemd/system"}/custom-gateway.service`;
      const service = {
        platform: "linux" as const,
        label: "custom-gateway.service",
        detail: `unit: ${unitPath}`,
        sourcePath: unitPath,
        scope,
        legacy: false,
      };
      mocks.findExtraGatewayServices.mockResolvedValue({
        services: [service],
        errors: [
          {
            source: "/etc/systemd/system/openclaw-unreadable.service",
            message: "Service path could not be inspected.",
          },
        ],
      });
      mocks.isSystemdUnitActive.mockResolvedValue(active);

      await maybeScanExtraGatewayServices({ deep: false }, makeDoctorIo(), makeDoctorPrompts());

      expect(mocks.isSystemdUnitActive).toHaveBeenCalledWith(
        process.env,
        "custom-gateway.service",
        scope,
      );
      expectNoteContaining("openclaw-unreadable.service", "Gateway service inspection incomplete");
      if (reported) {
        expectNoteContaining("custom-gateway.service", "Other gateway-like services detected");
        expect(mocks.renderGatewayServiceCleanupHints).toHaveBeenCalledWith([service]);
        expectNoteContaining(
          `systemctl --${scope} status -- custom-gateway.service`,
          "Inspection hints",
        );
        expectNoteContaining(
          `systemctl --${scope} cat -- custom-gateway.service`,
          "Inspection hints",
        );
        expectNoNoteContaining(`rm ${unitPath}`, "Cleanup hints");
      } else {
        expectNoNoteContaining("custom-gateway.service", "Other gateway-like services detected");
      }
      expect(mocks.uninstallLegacySystemdUnits).not.toHaveBeenCalled();
    },
  );

  it("keeps Windows Node diagnostics with inspection advice", async () => {
    mockProcessPlatform("win32");
    const { renderGatewayServiceCleanupHints } =
      await vi.importActual<typeof import("../daemon/inspect.js")>("../daemon/inspect.js");
    mocks.renderGatewayServiceCleanupHints.mockImplementation(renderGatewayServiceCleanupHints);
    mocks.findExtraGatewayServices.mockResolvedValue({
      services: [
        {
          platform: "win32",
          label: "\\OpenClaw Node",
          detail: "task: \\OpenClaw Node, run: C:\\OpenClaw\\openclaw.exe node run",
          scope: "system",
          marker: "openclaw",
          legacy: false,
        },
      ],
      errors: [],
    });

    await maybeScanExtraGatewayServices({ deep: true }, makeDoctorIo(), makeDoctorPrompts());

    expectNoteContaining("\\OpenClaw Node", "Other gateway-like services detected");
    expectNoteContaining('schtasks /Query /TN "\\OpenClaw Node" /V /FO LIST', "Inspection hints");
    expectNoNoteContaining("/Delete", "Cleanup hints");
    expect(mocks.uninstallLegacySystemdUnits).not.toHaveBeenCalled();
    expect(mocks.execLaunchctl).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "limits macOS cleanup hints to non-legacy extras (legacy=%s)",
    async (legacy) => {
      mockProcessPlatform("darwin");
      const extraService = {
        platform: "darwin" as const,
        label: "com.example.openclaw-gateway",
        detail: "plist: /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
        sourcePath: "/Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
        scope: "user" as const,
        legacy,
      };
      mocks.findExtraGatewayServices.mockResolvedValue({ services: [extraService], errors: [] });
      mocks.renderGatewayServiceCleanupHints.mockReturnValue(
        legacy
          ? []
          : [
              "launchctl bootout gui/$UID/com.example.openclaw-gateway",
              "rm /Users/test/Library/LaunchAgents/com.example.openclaw-gateway.plist",
            ],
      );
      await maybeScanExtraGatewayServices({ deep: false }, makeDoctorIo(), {
        ...makeDoctorPrompts(),
        confirmRuntimeRepair: vi.fn().mockResolvedValue(false),
      });
      expect(mocks.renderGatewayServiceCleanupHints).toHaveBeenCalledWith(
        legacy ? [] : [extraService],
      );
      if (!legacy) {
        expectNoteContaining("com.example.openclaw-gateway", "Cleanup hints");
      }
      expectNoNoteContaining("ai.openclaw.gateway", "Cleanup hints");
    },
  );

  it("reports incomplete inspection without offering cleanup for an unverified service", async () => {
    mockProcessPlatform("darwin");
    const source = "/Users/test/Library/LaunchAgents/ai.openclaw.backup.plist";
    mocks.findExtraGatewayServices.mockResolvedValue({
      services: [],
      errors: [{ source, message: "Service plist could not be inspected." }],
    });
    const prompts = makeDoctorPrompts();

    await maybeScanExtraGatewayServices({ deep: true }, makeDoctorIo(), prompts);

    expect(mocks.findExtraGatewayServices).toHaveBeenCalledWith(process.env, { deep: true });
    expectNoteContaining(source, "Gateway service inspection incomplete");
    expectNoteContaining("could not be inspected", "Gateway service inspection incomplete");
    expect(mocks.renderGatewayServiceCleanupHints).not.toHaveBeenCalled();
    expect(prompts.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(mocks.execLaunchctl).not.toHaveBeenCalled();
    expect(mocks.uninstallLegacySystemdUnits).not.toHaveBeenCalled();
  });

  it("skips structured host-service discovery in containers without an OpenClaw service", async () => {
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
      mocks.findExtraGatewayServices.mockResolvedValue({
        services: [
          {
            platform: "linux",
            label,
            detail: `unit: /home/test/.config/systemd/user/${label}`,
            sourcePath: `/home/test/.config/systemd/user/${label}`,
            scope: "user",
            marker: "clawdbot",
            legacy: true,
          },
        ],
        errors: [],
      });
      mocks.uninstallLegacySystemdUnits.mockResolvedValue([
        {
          name: "clawdbot-gateway",
          unitPath: "/home/test/.config/systemd/user/clawdbot-gateway.service",
          enabled: true,
          exists: true,
        },
      ]);
      const runtime = makeDoctorIo();
      await withEnvAsync(
        { OPENCLAW_SERVICE_REPAIR_POLICY: kind === "external" ? "external" : undefined },
        () => maybeScanExtraGatewayServices({ deep: false }, runtime, makeDoctorPrompts()),
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
      expect(runtime.log).not.toHaveBeenCalledWith(
        expect.stringContaining("Installing OpenClaw gateway next."),
      );
    },
  );

  it.each<{
    name: string;
    stderr?: string;
    registered?: boolean;
    accessError?: string;
    moveError?: boolean;
    reason?: string;
  }>([
    { name: "missing service", stderr: "Could not find service" },
    { name: "missing process", stderr: "No such process" },
    { name: "registered stopped label", registered: true },
    { name: "absent plist", accessError: "ENOENT" },
    { name: "uninspectable plist", accessError: "EACCES", reason: "could not inspect plist" },
    { name: "unmovable plist", moveError: true, reason: "could not move plist" },
  ])(
    "settles confirmed legacy macOS cleanup for $name",
    async ({ stderr = "Could not find service", registered, accessError, moveError, reason }) => {
      setupLegacyMacService();
      mocks.execLaunchctl
        .mockResolvedValueOnce(launchctlResult())
        .mockResolvedValueOnce(launchctlResult());
      if (registered) {
        mocks.execLaunchctl.mockResolvedValueOnce(
          launchctlResult({ stdout: "state = waiting\npid = 0\n" }),
        );
      }
      mocks.execLaunchctl.mockResolvedValueOnce(launchctlResult({ code: 113, stderr }));
      vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
      const access = vi.spyOn(fs, "access").mockResolvedValue(undefined);
      if (accessError) {
        access.mockRejectedValue(Object.assign(new Error(accessError), { code: accessError }));
      }
      const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);
      if (moveError) {
        rename.mockRejectedValue(new Error("permission denied"));
      }
      const runtime = makeDoctorIo();
      await maybeScanExtraGatewayServices({ deep: false }, runtime, makeDoctorPrompts());
      expectBoundedLaunchctlCleanup();
      expect(mocks.execLaunchctl).toHaveBeenCalledTimes(registered ? 4 : 3);
      expect(rename).toHaveBeenCalledTimes(accessError ? 0 : 1);
      if (reason) {
        expectNoteContaining(`${LEGACY_MAC_LABEL} (${reason})`, "Legacy gateway cleanup skipped");
        expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
      } else {
        expectNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
        expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway cleanup skipped");
      }
      expect(runtime.log).not.toHaveBeenCalledWith(
        expect.stringContaining("Installing OpenClaw gateway next."),
      );
    },
  );

  it.each([
    {
      name: "timeouts",
      results: Array.from({ length: 3 }, () =>
        launchctlResult({ code: 124, termination: "timeout" }),
      ),
    },
    {
      name: "unknown failures",
      results: Array.from({ length: 3 }, () =>
        launchctlResult({ code: 1, stderr: "Permission denied" }),
      ),
    },
    {
      name: "loaded probe after successful unload",
      results: [
        launchctlResult({ code: 124, termination: "timeout" }),
        launchctlResult(),
        launchctlResult({ stdout: "state = waiting\npid = 0\n" }),
        launchctlResult({ code: 1, stderr: "Permission denied" }),
      ],
    },
  ])("keeps the plist after $name", async ({ results }) => {
    setupLegacyMacService();
    for (const result of results) {
      mocks.execLaunchctl.mockResolvedValueOnce(result);
    }
    const mkdir = vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
    const access = vi.spyOn(fs, "access").mockResolvedValue(undefined);
    const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);
    const runtime = makeDoctorIo();
    await maybeScanExtraGatewayServices({ deep: false }, runtime, makeDoctorPrompts());
    expectBoundedLaunchctlCleanup();
    expect(mocks.execLaunchctl).toHaveBeenCalledTimes(results.length);
    expect(mkdir).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expectNoteContaining(
      `${LEGACY_MAC_LABEL} (launchctl could not confirm unload)`,
      "Legacy gateway cleanup skipped",
    );
    expectNoNoteContaining(LEGACY_MAC_LABEL, "Legacy gateway removed");
    expect(runtime.log).not.toHaveBeenCalledWith(
      "Legacy gateway services removed. Installing OpenClaw gateway next.",
    );
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
        vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
        vi.spyOn(fs, "access").mockResolvedValue(undefined);
        const rename = vi.spyOn(fs, "rename").mockResolvedValue(undefined);
        await withEnvAsync({ PATH: dir }, async () => {
          await maybeScanExtraGatewayServices({ deep: false }, makeDoctorIo(), makeDoctorPrompts());
        });
        expect(rename).toHaveBeenCalledTimes(signal ? 0 : 1);
        expectNoteContaining(
          LEGACY_MAC_LABEL,
          signal ? "Legacy gateway cleanup skipped" : "Legacy gateway removed",
        );
      });
    },
  );
});
