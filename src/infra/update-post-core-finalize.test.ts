import { describe, expect, it, vi } from "vitest";
import {
  foldPostCoreFinalizeIntoResult,
  type PostCoreFinalizeSpawner,
  runPostCoreFinalizeAfterGatewayUpdate,
} from "./update-post-core-finalize.js";
import type { UpdateRunResult } from "./update-runner.js";

function gitOkResult(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return {
    status: "ok",
    mode: "git",
    root: "/srv/openclaw",
    before: { sha: "aaa", version: "2026.5.3" },
    after: { sha: "bbb", version: "2026.6.1" },
    steps: [],
    durationMs: 10,
    ...overrides,
  };
}

const ENTRYPOINT = "/srv/openclaw/dist/index.mjs";
const resolveEntrypointOk = async () => ENTRYPOINT;

describe("runPostCoreFinalizeAfterGatewayUpdate", () => {
  it("skips non-git update modes", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>();
    for (const result of [
      gitOkResult({ mode: "pnpm" }),
      gitOkResult({ status: "error" }),
      gitOkResult({ status: "skipped" }),
      gitOkResult({ root: undefined }),
    ]) {
      const outcome = await runPostCoreFinalizeAfterGatewayUpdate({
        result,
        resolveEntrypoint: resolveEntrypointOk,
        spawnFinalize,
      });
      expect(outcome).toEqual({ status: "skipped", reason: "not-git-update" });
    }
    expect(spawnFinalize).not.toHaveBeenCalled();
  });

  it("skips when no built entrypoint is found", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>();
    const outcome = await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult(),
      resolveEntrypoint: async () => undefined,
      spawnFinalize,
    });
    expect(outcome).toEqual({ status: "skipped", reason: "entrypoint-missing" });
    expect(spawnFinalize).not.toHaveBeenCalled();
  });

  it("spawns `update finalize` against the rebuilt binary and reports success", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>(async () => ({ code: 0 }));
    const outcome = await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult(),
      channel: "stable",
      timeoutMs: 120_000,
      resolveEntrypoint: resolveEntrypointOk,
      spawnFinalize,
    });
    expect(outcome).toEqual({ status: "ok", entrypoint: ENTRYPOINT });
    expect(spawnFinalize).toHaveBeenCalledTimes(1);
    const call = spawnFinalize.mock.calls[0]![0];
    // Reconcile runs through the designed finalizer; never restarts (RPC owns restart).
    expect(call.argv).toEqual([
      expect.any(String),
      ENTRYPOINT,
      "update",
      "finalize",
      "--json",
      "--yes",
      "--no-restart",
      "--channel",
      "stable",
      "--timeout",
      "120",
    ]);
    // Host-compat resolution is pinned to the just-installed core version.
    expect(call.env.OPENCLAW_COMPATIBILITY_HOST_VERSION).toBe("2026.6.1");
  });

  it("omits channel/timeout flags when not provided", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>(async () => ({ code: 0 }));
    await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult(),
      resolveEntrypoint: resolveEntrypointOk,
      spawnFinalize,
    });
    const argv = spawnFinalize.mock.calls[0]![0].argv;
    expect(argv).not.toContain("--channel");
    expect(argv).not.toContain("--timeout");
  });

  it("reports error on a non-zero finalize exit", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>(async () => ({
      code: 1,
      stderr: "convergence failed",
    }));
    const outcome = await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult(),
      resolveEntrypoint: resolveEntrypointOk,
      spawnFinalize,
    });
    expect(outcome).toEqual({
      status: "error",
      reason: "nonzero-exit",
      entrypoint: ENTRYPOINT,
      exitCode: 1,
      message: "convergence failed",
    });
  });

  it("reports error when the finalize spawn throws", async () => {
    const spawnFinalize = vi.fn<PostCoreFinalizeSpawner>(async () => {
      throw new Error("ENOENT");
    });
    const outcome = await runPostCoreFinalizeAfterGatewayUpdate({
      result: gitOkResult(),
      resolveEntrypoint: resolveEntrypointOk,
      spawnFinalize,
    });
    expect(outcome).toEqual({
      status: "error",
      reason: "spawn-failed",
      entrypoint: ENTRYPOINT,
      message: "ENOENT",
    });
  });
});

describe("foldPostCoreFinalizeIntoResult", () => {
  it("leaves the result unchanged for ok/skipped outcomes", () => {
    const result = gitOkResult();
    expect(foldPostCoreFinalizeIntoResult(result, { status: "ok", entrypoint: ENTRYPOINT })).toBe(
      result,
    );
    expect(
      foldPostCoreFinalizeIntoResult(result, { status: "skipped", reason: "not-git-update" }),
    ).toBe(result);
  });

  it("flips status to error so the RPC restart gate is skipped", () => {
    const result = gitOkResult();
    const folded = foldPostCoreFinalizeIntoResult(result, {
      status: "error",
      reason: "nonzero-exit",
      entrypoint: ENTRYPOINT,
      exitCode: 2,
      message: "boom",
    });
    expect(folded.status).toBe("error");
    expect(folded.reason).toBe("post-core-plugin-finalize-failed");
    expect(folded.steps.at(-1)).toMatchObject({
      name: "post-core plugin finalize",
      exitCode: 2,
      stderrTail: "boom",
    });
    // Core update metadata is preserved for the sentinel.
    expect(folded.after).toEqual(result.after);
  });
});
