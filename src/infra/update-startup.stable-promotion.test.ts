import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCheckResult } from "./update-check.js";

vi.mock("./openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(),
}));

vi.mock("./update-check.js", async () => {
  const actual = await vi.importActual<typeof import("./update-check.js")>("./update-check.js");
  return {
    ...actual,
    checkUpdateStatus: vi.fn(),
    resolveNpmChannelTag: vi.fn(),
  };
});

vi.mock("../version.js", () => ({
  VERSION: "2026.3.1-beta.1",
}));

describe("runGatewayUpdateCheck stable-promotion alias handling", () => {
  let tempDir = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-promotion-"));
    process.env.OPENCLAW_STATE_DIR = tempDir;
    delete process.env.VITEST;
    process.env.NODE_ENV = "test";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.OPENCLAW_STATE_DIR;
  });

  it("does not report update available when latest stable only drops prerelease suffix", async () => {
    const { resolveOpenClawPackageRoot } = await import("./openclaw-root.js");
    const { checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js");
    const { getUpdateAvailable, resetUpdateAvailableStateForTest, runGatewayUpdateCheck } =
      await import("./update-startup.js");

    resetUpdateAvailableStateForTest();
    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "package",
      packageManager: "npm",
    } satisfies UpdateCheckResult);
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "latest",
      version: "2026.3.1",
    });

    const onUpdateAvailableChange = vi.fn();
    await runGatewayUpdateCheck({
      cfg: { update: { channel: "stable" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      onUpdateAvailableChange,
    });

    expect(getUpdateAvailable()).toBeNull();
    expect(onUpdateAvailableChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ latestVersion: "2026.3.1" }),
    );
  });

  it("keeps persisted prerelease-equivalent update visible on beta channel", async () => {
    const { resolveOpenClawPackageRoot } = await import("./openclaw-root.js");
    const { checkUpdateStatus, resolveNpmChannelTag } = await import("./update-check.js");
    const { getUpdateAvailable, resetUpdateAvailableStateForTest, runGatewayUpdateCheck } =
      await import("./update-startup.js");

    resetUpdateAvailableStateForTest();
    const nowIso = new Date().toISOString();
    await fs.writeFile(
      path.join(tempDir, "update-check.json"),
      JSON.stringify({
        lastCheckedAt: nowIso,
        lastAvailableVersion: "2026.3.1",
        lastAvailableTag: "latest",
      }),
      "utf-8",
    );

    vi.mocked(resolveOpenClawPackageRoot).mockResolvedValue("/opt/openclaw");
    vi.mocked(checkUpdateStatus).mockResolvedValue({
      root: "/opt/openclaw",
      installKind: "package",
      packageManager: "npm",
    } satisfies UpdateCheckResult);
    vi.mocked(resolveNpmChannelTag).mockResolvedValue({
      tag: "beta",
      version: "2026.3.1-beta.1",
    });

    const onUpdateAvailableChange = vi.fn();
    await runGatewayUpdateCheck({
      cfg: { update: { channel: "beta" } },
      log: { info: vi.fn() },
      isNixMode: false,
      allowInTests: true,
      onUpdateAvailableChange,
    });

    expect(getUpdateAvailable()).toEqual({
      currentVersion: "2026.3.1-beta.1",
      latestVersion: "2026.3.1",
      channel: "latest",
    });
    expect(onUpdateAvailableChange).toHaveBeenCalledWith(
      expect.objectContaining({ latestVersion: "2026.3.1" }),
    );
  });
});
