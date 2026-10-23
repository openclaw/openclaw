import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReadPermissions,
  githubJson,
  parsePermissionKeys,
  parseRepoArg,
  readGitHubAppPrivateKey,
  readBoundedGitHubErrorText,
  readBoundedGitHubJson,
  resolveGitHubFetchTimeoutMs,
} from "../../scripts/gh-read.js";
import { normalizeGitHubRepo as normalizeRepo } from "../../scripts/lib/github-repo.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const oversizedError = { code: "ETOOBIG", message: "GitHub API response body exceeded 1024 bytes" };
function streamed(source: UnderlyingSource<Uint8Array>, init?: ResponseInit) {
  return new Response(new ReadableStream(source), init);
}
async function expectTimeout(request: Promise<unknown>, message: RegExp) {
  const rejection = expect(request).rejects.toThrow(message);
  await vi.advanceTimersByTimeAsync(5);
  await rejection;
}

describe("gh-read helpers", () => {
  afterEach(() => vi.useRealTimers());

  it("finds repo from gh args", () => {
    expect(parseRepoArg(["pr", "view", "42", "-R", "openclaw/openclaw"])).toBe("openclaw/openclaw");
    expect(parseRepoArg(["run", "list", "--repo=openclaw/docs"])).toBe("openclaw/docs");
    expect(parseRepoArg(["pr", "view", "42"])).toBeNull();
  });

  it("normalizes repo strings from common git formats", () => {
    expect(normalizeRepo("openclaw/openclaw")).toBe("openclaw/openclaw");
    expect(normalizeRepo("github.com/openclaw/openclaw")).toBe("openclaw/openclaw");
    expect(normalizeRepo("github:openclaw/openclaw")).toBe("openclaw/openclaw");
    expect(normalizeRepo("https://github.com/openclaw/openclaw.git")).toBe("openclaw/openclaw");
    expect(normalizeRepo("git@github.com:openclaw/openclaw.git")).toBe("openclaw/openclaw");
    expect(normalizeRepo("https://gitlab.com/openclaw/openclaw.git")).toBeNull();
    expect(normalizeRepo("invalid")).toBeNull();
  });

  it("builds a read-only permission subset from granted permissions", () => {
    const permissions = {
      actions: "write",
      issues: "read",
      administration: "write",
      metadata: "read",
      statuses: null,
    } as const;
    expect(buildReadPermissions(permissions, Object.keys(permissions))).toEqual({
      administration: "read",
      actions: "read",
      issues: "read",
      metadata: "read",
    });
  });

  it("parses permission key overrides", () => {
    expect(parsePermissionKeys(undefined)).toContain("pull_requests");
    expect(parsePermissionKeys("actions, contents ,issues")).toEqual([
      "actions",
      "contents",
      "issues",
    ]);
  });

  it("bounds GitHub App private key files", () => {
    const privateKeyPath = path.join(tempDirs.make("openclaw-gh-read-key-"), "app.pem");
    writeFileSync(privateKeyPath, "x".repeat(64 * 1024));
    expect(readGitHubAppPrivateKey(privateKeyPath)).toHaveLength(64 * 1024);
    writeFileSync(privateKeyPath, "x".repeat(64 * 1024 + 1));
    expect(() => readGitHubAppPrivateKey(privateKeyPath)).toThrowError(
      expect.objectContaining({
        name: "FsSafeError",
        code: "too-large",
        message: `GitHub App private key file at ${privateKeyPath} exceeds 65536 bytes.`,
      }),
    );
  });

  it("aborts stalled GitHub API fetches at the request timeout", async () => {
    let signal: AbortSignal | undefined;
    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });

    vi.useFakeTimers();
    const request = githubJson("/app", "token", undefined, {
      timeoutMs: 5,
      fetchImpl: ((_url, init) => {
        signal = init?.signal ?? undefined;
        markFetchStarted();
        return new Promise(() => {});
      }) as typeof fetch,
    });
    await fetchStarted;
    await expectTimeout(request, /GitHub API GET \/app exceeded timeout/u);
    expect(signal?.aborted).toBe(true);
  });

  it("times out stalled GitHub API response body reads", async () => {
    const cancel = vi.fn();
    vi.useFakeTimers();
    const response = streamed({ pull: () => new Promise(() => {}), cancel });
    const request = githubJson("/app/installations", "token", undefined, {
      timeoutMs: 5,
      fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
    });
    await expectTimeout(request, /GitHub API GET \/app\/installations exceeded timeout/u);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalled();
  });

  it.each([
    ["drops a split surrogate pair", `abc\u{1f600}tail`, "abc\n[truncated]"],
    ["preserves a complete surrogate pair", `ab\u{1f600}tail`, `ab\u{1f600}\n[truncated]`],
  ])(
    "keeps GitHub API error truncation UTF-16 safe: %s",
    async (_name, responseBody, expectedText) => {
      const response = new Response(responseBody, { status: 500 });

      await expect(readBoundedGitHubErrorText(response, 4)).resolves.toBe(expectedText);
    },
  );

  it("reads bounded GitHub API JSON responses", async () => {
    const response = new Response('{"id":123}');
    await expect(readBoundedGitHubJson(response, 1024)).resolves.toEqual({ id: 123 });
  });

  it("rejects oversized GitHub API JSON responses by content length", async () => {
    const cancel = vi.fn();
    const response = streamed({ cancel }, { headers: { "content-length": "1025" } });
    await expect(readBoundedGitHubJson(response, 1024)).rejects.toMatchObject(oversizedError);
    expect(cancel).toHaveBeenCalled();
  });

  it("rejects invalid GitHub API timeout values", () => {
    expect(resolveGitHubFetchTimeoutMs("1000")).toBe(1000);
    expect(() => resolveGitHubFetchTimeoutMs("1s")).toThrow(
      /OPENCLAW_GH_READ_FETCH_TIMEOUT_MS must be an integer/u,
    );
  });
});
