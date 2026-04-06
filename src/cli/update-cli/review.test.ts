import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("../../version.js", () => ({ VERSION: "2026.4.1" }));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: vi.fn().mockResolvedValue({
    path: "/fake/.openclaw/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    sourceConfig: {},
    config: {},
    issues: [],
  }),
}));

vi.mock("../../infra/update-channels.js", () => ({
  normalizeUpdateChannel: vi.fn().mockReturnValue(null),
  DEFAULT_GIT_CHANNEL: "dev",
  DEFAULT_PACKAGE_CHANNEL: "stable",
}));

vi.mock("../../infra/update-check.js", () => ({
  checkUpdateStatus: vi.fn(),
  compareSemverStrings: vi.fn(),
  resolveNpmChannelTag: vi.fn().mockResolvedValue({ tag: "latest", version: null }),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
    writeJson: vi.fn(),
  },
}));

import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  resolveNpmChannelTag,
} from "../../infra/update-check.js";
import { defaultRuntime } from "../../runtime.js";
// Import after mocks
import { updateReviewCommand } from "./review.js";

const mockCheckUpdateStatus = vi.mocked(checkUpdateStatus);
const mockCompareSemverStrings = vi.mocked(compareSemverStrings);
const mockNormalizeUpdateChannel = vi.mocked(normalizeUpdateChannel);
const mockResolveNpmChannelTag = vi.mocked(resolveNpmChannelTag);
const mockRuntime = vi.mocked(defaultRuntime);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUpdateStatus(latestVersion: string | null, gitBehind?: number) {
  return {
    root: "/fake",
    installKind: (gitBehind !== undefined ? "git" : "package") as "git" | "package",
    packageManager: "npm" as const,
    registry: { latestVersion },
    git:
      gitBehind !== undefined
        ? { behind: gitBehind, sha: "abc1234", branch: "main", tag: null, dirty: false, ahead: 0, upstream: "origin/main", fetchOk: true }
        : undefined,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("updateReviewCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress fetch errors in tests
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network unavailable")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports up-to-date when no update is available", async () => {
    mockCheckUpdateStatus.mockResolvedValue(makeUpdateStatus("2026.4.1"));
    mockCompareSemverStrings.mockReturnValue(0);

    await updateReviewCommand({});

    const logged = mockRuntime.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("up to date");
  });

  it("detects update available and emits recommendation", async () => {
    mockCheckUpdateStatus.mockResolvedValue(makeUpdateStatus("2026.4.2"));
    mockCompareSemverStrings.mockReturnValue(-1);

    await updateReviewCommand({});

    const logged = mockRuntime.log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("2026.4.2");
    expect(logged).toMatch(/Recommendation|upgrade|review/i);
  });

  it("emits JSON output when --json is set", async () => {
    mockCheckUpdateStatus.mockResolvedValue(makeUpdateStatus("2026.4.2"));
    mockCompareSemverStrings.mockReturnValue(-1);

    await updateReviewCommand({ json: true });

    expect(mockRuntime.writeJson).toHaveBeenCalledOnce();
    const result = mockRuntime.writeJson.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(result).toMatchObject({
      installedVersion: "2026.4.1",
      latestVersion: "2026.4.2",
      updateAvailable: true,
    });
    // riskLevel is null when GitHub notes unavailable (fetch stubbed to reject)
    expect(result).toHaveProperty("riskLevel");
    expect(result).toHaveProperty("gitBehind");
    expect(result).toHaveProperty("recommendation");
    expect(result).toHaveProperty("localImpact");
  });

  it("reports registry-unavailable when npm lookup fails (package install)", async () => {
    // latestVersion=null means the registry call failed
    mockCheckUpdateStatus.mockResolvedValue(makeUpdateStatus(null));
    // compareSemverStrings never called when latestVersion is null

    await updateReviewCommand({ json: true });

    expect(mockRuntime.writeJson).toHaveBeenCalledOnce();
    const result = mockRuntime.writeJson.mock.calls[0]?.[0] as Record<string, unknown>;
    // Must not claim up-to-date when we simply couldn't check
    expect(result).toMatchObject({
      updateAvailable: false,
      checkUnavailable: true,
      recommendation: "review",
    });
    expect((result.recommendationReason as string)).toContain("Registry unavailable");
  });

  it("detects git-behind update for git installs (same npm version)", async () => {
    // latestVersion same as installed, but git checkout is 3 commits behind
    mockCheckUpdateStatus.mockResolvedValue(makeUpdateStatus("2026.4.1", 3));
    mockCompareSemverStrings.mockReturnValue(0); // npm is current

    await updateReviewCommand({ json: true });

    expect(mockRuntime.writeJson).toHaveBeenCalledOnce();
    const result = mockRuntime.writeJson.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(result).toMatchObject({
      updateAvailable: true,
      checkUnavailable: false,
      gitBehind: 3,
      // Should recommend review, not upgrade — can't score pending commits
      recommendation: "review",
    });
    expect((result.recommendationReason as string)).toContain("3 commits behind");
  });

  it("recommends review when release notes unavailable (unknown risk)", async () => {
    mockCheckUpdateStatus.mockResolvedValue(makeUpdateStatus("2026.4.2"));
    mockCompareSemverStrings.mockReturnValue(-1);
    // fetch is stubbed to reject, so riskLevel will be null

    await updateReviewCommand({ json: true });

    expect(mockRuntime.writeJson).toHaveBeenCalledOnce();
    const result = mockRuntime.writeJson.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(result).toMatchObject({
      riskLevel: null,
      recommendation: "review",
    });
  });

  it("emits up-to-date JSON when no update available", async () => {
    mockCheckUpdateStatus.mockResolvedValue(makeUpdateStatus("2026.4.1"));
    mockCompareSemverStrings.mockReturnValue(0);

    await updateReviewCommand({ json: true });

    expect(mockRuntime.writeJson).toHaveBeenCalledOnce();
    const result = mockRuntime.writeJson.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(result).toMatchObject({
      updateAvailable: false,
      checkUnavailable: false,
      recommendation: "up-to-date",
      gitBehind: null,
    });
  });

  it("defaults git installs to dev channel when no config set", async () => {
    // No channel in config
    mockNormalizeUpdateChannel.mockReturnValue(null);
    // Git install, 0 behind (we'll test via resolveNpmChannelTag being called with dev)
    mockCheckUpdateStatus.mockResolvedValue(makeUpdateStatus("2026.4.1", 0));
    mockResolveNpmChannelTag.mockResolvedValue({ tag: "dev", version: "2026.4.2-dev.5" });
    mockCompareSemverStrings.mockReturnValue(-1);

    await updateReviewCommand({ json: true });

    // Should resolve against dev channel, not stable
    expect(mockResolveNpmChannelTag).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "dev" }),
    );
    const result = mockRuntime.writeJson.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(result).toMatchObject({
      latestVersion: "2026.4.2-dev.5",
      updateAvailable: true,
    });
  });

  it("uses beta channel version when config specifies beta", async () => {
    // Config says beta channel
    mockNormalizeUpdateChannel.mockReturnValue("beta");
    // resolveNpmChannelTag returns the beta version
    mockResolveNpmChannelTag.mockResolvedValue({ tag: "beta", version: "2026.5.0-beta.1" });
    // registry.latestVersion is the stable version (older) — should be ignored
    mockCheckUpdateStatus.mockResolvedValue(makeUpdateStatus("2026.4.1"));
    // VERSION (2026.4.1) < beta version (2026.5.0-beta.1)
    mockCompareSemverStrings.mockReturnValue(-1);

    await updateReviewCommand({ json: true });

    expect(mockResolveNpmChannelTag).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "beta" }),
    );
    expect(mockRuntime.writeJson).toHaveBeenCalledOnce();
    const result = mockRuntime.writeJson.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(result).toMatchObject({
      latestVersion: "2026.5.0-beta.1",
      updateAvailable: true,
    });
  });
});
