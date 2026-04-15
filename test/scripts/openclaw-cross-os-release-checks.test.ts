import { describe, expect, it } from "vitest";
import {
  buildDiscordSmokeGuildsConfig,
  looksLikeReleaseVersionRef,
  normalizeWindowsInstalledCliPath,
  parseArgs,
  readRunnerOverrideEnv,
  resolveRepairGlobalInstallArgs,
  resolveRequestedSuites,
  resolveRunnerMatrix,
  resolveStaticFileContentType,
  shouldRunMainChannelDevUpdate,
  shouldUseManagedGatewayService,
  verifyDevUpdateStatus,
} from "../../scripts/openclaw-cross-os-release-checks.mjs";

describe("scripts/openclaw-cross-os-release-checks", () => {
  it("treats explicit empty-string args as values instead of boolean flags", () => {
    expect(parseArgs(["--ubuntu-runner", "", "--mode", "both"])).toEqual({
      "ubuntu-runner": "",
      mode: "both",
    });
  });

  it("detects release refs and keeps branch refs out of release-only logic", () => {
    expect(looksLikeReleaseVersionRef("2026.4.5")).toBe(true);
    expect(looksLikeReleaseVersionRef("v2026.4.5-beta.1")).toBe(true);
    expect(looksLikeReleaseVersionRef("v2026.4.7-1")).toBe(true);
    expect(looksLikeReleaseVersionRef("main")).toBe(false);
    expect(looksLikeReleaseVersionRef("codex/cross-os-release-checks")).toBe(false);
  });

  it("skips the dev-update suite for immutable release refs", () => {
    expect(resolveRequestedSuites("both", "v2026.4.5")).toEqual([
      "packaged-fresh",
      "installer-fresh",
      "packaged-upgrade",
    ]);
  });

  it("includes all native suites for branch validation refs", () => {
    expect(resolveRequestedSuites("both", "codex/cross-os-release-checks")).toEqual([
      "packaged-fresh",
      "installer-fresh",
      "packaged-upgrade",
      "dev-update",
    ]);
  });

  it("builds a suite-aware runner matrix with the beefy Windows default", () => {
    const matrix = resolveRunnerMatrix({
      mode: "both",
      ref: "main",
      ubuntuRunner: "",
      windowsRunner: "",
      macosRunner: "",
      varUbuntuRunner: "",
      varWindowsRunner: "",
      varMacosRunner: "",
    });

    expect(matrix.include).toHaveLength(12);
    expect(matrix.include).toContainEqual(
      expect.objectContaining({
        os_id: "windows",
        runner: "blacksmith-32vcpu-windows-2025",
        suite: "dev-update",
        lane: "upgrade",
      }),
    );
    expect(matrix.include).toContainEqual(
      expect.objectContaining({
        os_id: "ubuntu",
        suite: "installer-fresh",
        lane: "fresh",
      }),
    );
  });

  it("prefers workflow-injected runner override env names over legacy ones", () => {
    expect(
      readRunnerOverrideEnv({
        VAR_UBUNTU_RUNNER: "workflow-linux",
        VAR_WINDOWS_RUNNER: "workflow-windows",
        VAR_MACOS_RUNNER: "workflow-macos",
        OPENCLAW_RELEASE_CHECKS_UBUNTU_RUNNER: "legacy-linux",
        OPENCLAW_RELEASE_CHECKS_WINDOWS_RUNNER: "legacy-windows",
        OPENCLAW_RELEASE_CHECKS_MACOS_RUNNER: "legacy-macos",
      }),
    ).toEqual({
      varUbuntuRunner: "workflow-linux",
      varWindowsRunner: "workflow-windows",
      varMacosRunner: "workflow-macos",
    });
  });

  it("serves installer scripts as UTF-8 text and package payloads as binary", () => {
    expect(resolveStaticFileContentType("scripts/install.sh")).toBe("text/plain; charset=utf-8");
    expect(resolveStaticFileContentType("scripts/install.ps1")).toBe("text/plain; charset=utf-8");
    expect(resolveStaticFileContentType("openclaw-2026.4.14.tgz")).toBe("application/octet-stream");
  });

  it("uses managed gateway services only on native Windows runners", () => {
    expect(shouldUseManagedGatewayService("win32")).toBe(true);
    expect(shouldUseManagedGatewayService("darwin")).toBe(false);
    expect(shouldUseManagedGatewayService("linux")).toBe(false);
  });

  it("normalizes Windows installed CLI paths to the cmd shim", () => {
    expect(
      normalizeWindowsInstalledCliPath(
        String.raw`C:\Users\runner\AppData\Roaming\npm\openclaw.ps1`,
      ),
    ).toBe(String.raw`C:\Users\runner\AppData\Roaming\npm\openclaw.cmd`);
    expect(
      normalizeWindowsInstalledCliPath(
        String.raw`C:\Users\runner\AppData\Roaming\npm\openclaw.cmd`,
      ),
    ).toBe(String.raw`C:\Users\runner\AppData\Roaming\npm\openclaw.cmd`);
  });

  it("uses a real global link when repairing git installs outside Windows", () => {
    expect(resolveRepairGlobalInstallArgs("darwin", "/tmp/openclaw")).toEqual(["link"]);
    expect(resolveRepairGlobalInstallArgs("linux", "/tmp/openclaw")).toEqual(["link"]);
    expect(resolveRepairGlobalInstallArgs("win32", String.raw`C:\temp\openclaw`)).toEqual([
      "install",
      "-g",
      String.raw`C:\temp\openclaw`,
      "--no-fund",
      "--no-audit",
    ]);
  });

  it("writes Discord smoke config using the strict guild channel schema", () => {
    expect(buildDiscordSmokeGuildsConfig("guild-123", "channel-456")).toEqual({
      "guild-123": {
        channels: {
          "channel-456": {
            enabled: true,
            requireMention: false,
          },
        },
      },
    });
  });

  it("only treats main as a real dev-update lane", () => {
    expect(shouldRunMainChannelDevUpdate("main")).toBe(true);
    expect(shouldRunMainChannelDevUpdate(" codex/cross-os-release-checks-full-native-e2e ")).toBe(
      false,
    );
    expect(shouldRunMainChannelDevUpdate("v2026.4.14")).toBe(false);
  });

  it("accepts a git main dev-channel update status payload", () => {
    expect(() =>
      verifyDevUpdateStatus(
        JSON.stringify({
          update: {
            installKind: "git",
            git: {
              branch: "main",
            },
          },
          channel: {
            value: "dev",
          },
        }),
      ),
    ).not.toThrow();
  });

  it("accepts a git dev-channel payload for a requested non-main branch", () => {
    expect(() =>
      verifyDevUpdateStatus(
        JSON.stringify({
          update: {
            installKind: "git",
            git: {
              branch: "codex/cross-os-release-checks-full-native-e2e",
              sha: "08753a1d793c040b101c8a26c43445dbbab14995",
            },
          },
          channel: {
            value: "dev",
          },
        }),
        { ref: "codex/cross-os-release-checks-full-native-e2e" },
      ),
    ).not.toThrow();
  });

  it("rejects update status payloads that are not on dev/main git", () => {
    expect(() =>
      verifyDevUpdateStatus(
        JSON.stringify({
          update: {
            installKind: "package",
            git: {
              branch: "release",
            },
          },
          channel: {
            value: "stable",
          },
        }),
      ),
    ).toThrow("git install");
  });
});
