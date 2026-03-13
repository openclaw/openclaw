import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareSemverStrings,
  fetchNpmLatestVersion,
  fetchNpmTagVersion,
  formatGitInstallLabel,
  resolveNpmChannelTag,
} from "./update-check.js";

describe("compareSemverStrings", () => {
  it("handles stable and prerelease precedence for both legacy and beta formats", () => {
    expect(compareSemverStrings("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemverStrings("v1.0.0", "1.0.0")).toBe(0);

    expect(compareSemverStrings("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);

    expect(compareSemverStrings("1.0.0-2", "1.0.0-1")).toBe(1);
    expect(compareSemverStrings("1.0.0-1", "1.0.0-beta.1")).toBe(-1);
    expect(compareSemverStrings("1.0.0.beta.2", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0", "1.0.0.beta.1")).toBe(1);
  });

  it("returns null for invalid inputs", () => {
    expect(compareSemverStrings("1.0", "1.0.0")).toBeNull();
    expect(compareSemverStrings("latest", "1.0.0")).toBeNull();
  });
});

describe("resolveNpmChannelTag", () => {
  let versionByTag: Record<string, string | null>;

  beforeEach(() => {
    versionByTag = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const tag = decodeURIComponent(url.split("/").pop() ?? "");
        const version = versionByTag[tag] ?? null;
        return {
          ok: version != null,
          status: version != null ? 200 : 404,
          json: async () => ({ version }),
        } as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to latest when beta is older", async () => {
    versionByTag.beta = "1.0.0-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1-1" });
  });

  it("keeps beta when beta is not older", async () => {
    versionByTag.beta = "1.0.2-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "beta", version: "1.0.2-beta.1" });
  });

  it("falls back to latest when beta has same base as stable", async () => {
    versionByTag.beta = "1.0.1-beta.2";
    versionByTag.latest = "1.0.1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1" });
  });

  it("keeps non-beta channels unchanged", async () => {
    versionByTag.latest = "1.0.3";

    await expect(resolveNpmChannelTag({ channel: "stable", timeoutMs: 1000 })).resolves.toEqual({
      tag: "latest",
      version: "1.0.3",
    });
  });

  it("exposes tag fetch helpers for success and http failures", async () => {
    versionByTag.latest = "1.0.4";

    await expect(fetchNpmTagVersion({ tag: "latest", timeoutMs: 1000 })).resolves.toEqual({
      tag: "latest",
      version: "1.0.4",
    });
    await expect(fetchNpmLatestVersion({ timeoutMs: 1000 })).resolves.toEqual({
      latestVersion: "1.0.4",
      error: undefined,
    });
    await expect(fetchNpmTagVersion({ tag: "beta", timeoutMs: 1000 })).resolves.toEqual({
      tag: "beta",
      version: null,
      error: "HTTP 404",
    });
  });
});

describe("formatGitInstallLabel", () => {
  it("formats branch, detached tag, and non-git installs", () => {
    expect(
      formatGitInstallLabel({
        root: "/repo",
        installKind: "git",
        packageManager: "pnpm",
        git: {
          root: "/repo",
          sha: "1234567890abcdef",
          tag: null,
          branch: "main",
          upstream: "origin/main",
          dirty: false,
          ahead: 0,
          behind: 0,
          fetchOk: true,
        },
      }),
    ).toBe("main · @ 12345678");

    expect(
      formatGitInstallLabel({
        root: "/repo",
        installKind: "git",
        packageManager: "pnpm",
        git: {
          root: "/repo",
          sha: "abcdef1234567890",
          tag: "v1.2.3",
          branch: "HEAD",
          upstream: null,
          dirty: false,
          ahead: 0,
          behind: 0,
          fetchOk: null,
        },
      }),
    ).toBe("detached · tag v1.2.3 · @ abcdef12");

    expect(
      formatGitInstallLabel({
        root: null,
        installKind: "package",
        packageManager: "pnpm",
      }),
    ).toBeNull();
  });
});
