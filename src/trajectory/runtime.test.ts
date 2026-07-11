// Trajectory runtime tests cover event recording and runtime file handling.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeSessionTrajectoryArtifacts } from "./cleanup.js";
import {
  TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
  resolveTrajectoryPointerOpenFlags,
} from "./paths.js";
import { createTrajectoryRuntimeRecorder, toTrajectoryToolDefinitions } from "./runtime.js";
import * as writerLifecycle from "./writer-lifecycle.js";
import {
  acquireTrajectoryWriterLease,
  canonicalizeTrajectoryPath,
  claimTrajectoryPathIncarnation,
  clearTrajectoryWriterLifecycleRegistryForTest,
  reapRetiredTrajectoryPathEntries,
  withTrajectoryPathLock,
} from "./writer-lifecycle.js";

type TrajectoryRuntimeRecorder = NonNullable<
  Awaited<ReturnType<typeof createTrajectoryRuntimeRecorder>>
>;

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-runtime-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  clearTrajectoryWriterLifecycleRegistryForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function expectTrajectoryRuntimeRecorder(
  recorderPromise: ReturnType<typeof createTrajectoryRuntimeRecorder>,
): Promise<TrajectoryRuntimeRecorder> {
  const recorder = await recorderPromise;
  if (recorder === null) {
    throw new Error("Expected trajectory runtime recorder");
  }
  expect(typeof recorder.recordEvent).toBe("function");
  return recorder;
}

/** Asserts originalPath is gone and a matching tombstone now exists. */
function expectTombstoned(originalPath: string, reason: "reset" | "deleted"): void {
  expect(fs.existsSync(originalPath)).toBe(false);
  const dir = path.dirname(originalPath);
  const prefix = `${path.basename(originalPath)}.${reason}.`;
  const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  expect(entries.some((name) => name.startsWith(prefix))).toBe(true);
}

describe("trajectory runtime", () => {
  it("resolves a session-adjacent trajectory file by default", () => {
    expect(
      resolveTrajectoryFilePath({
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
      }),
    ).toBe("/tmp/session.trajectory.jsonl");
  });

  it("sanitizes session ids when resolving an override directory", () => {
    expect(
      resolveTrajectoryFilePath({
        env: { OPENCLAW_TRAJECTORY_DIR: "/tmp/traces" },
        sessionId: "../evil/session",
      }),
    ).toBe(path.join(path.resolve("/tmp/traces"), "___evil_session.jsonl"));
  });

  it("records sanitized runtime events by default", async () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      workspaceDir: "/tmp/workspace",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = await expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      systemPrompt: "system prompt",
      headers: [{ name: "Authorization", value: "Bearer sk-test-secret-token" }],
      command: "curl -H 'Authorization: Bearer sk-other-secret-token'",
      oauth: "ya29.fake-access-token-with-enough-length",
      apple: "abcd-efgh-ijkl-mnop",
      tools: toTrajectoryToolDefinitions([
        { name: "z-tool", parameters: { z: 1 } },
        { name: "a-tool", description: "alpha", parameters: { a: 1 } },
        { name: " ", description: "ignored" },
      ]),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.type).toBe("context.compiled");
    expect(parsed.source).toBe("runtime");
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.data.tools).toEqual([
      { name: "a-tool", description: "alpha", parameters: { a: 1 } },
      { name: "z-tool", parameters: { z: 1 } },
    ]);
    expect(JSON.stringify(parsed.data)).not.toContain("sk-test-secret-token");
    expect(JSON.stringify(parsed.data)).not.toContain("sk-other-secret-token");
    expect(JSON.stringify(parsed.data)).not.toContain("ya29.fake-access-token");
    expect(JSON.stringify(parsed.data)).not.toContain("abcd-efgh-ijkl-mnop");
  });

  it("bounds large runtime event fields before serialization", async () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = await expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("context.compiled", {
      prompt: "x".repeat(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.data.prompt.truncated).toBe(true);
    expect(parsed.data.prompt.reason).toBe("trajectory-field-size-limit");
    expect(Buffer.byteLength(writes[0], "utf8")).toBeLessThanOrEqual(
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1,
    );
  });

  it("preserves usage when truncating oversized runtime events", async () => {
    const writes: string[] = [];
    const usage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    const promptCache = { readTokens: 333_824, writeTokens: 51_130 };
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = await expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("model.completed", {
      usage,
      promptCache,
      messagesSnapshot: Array.from({ length: 12 }, (_value, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(32_000)}`,
      })),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.type).toBe("model.completed");
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      usage,
      promptCache,
    });
    expect(parsed.data.messagesSnapshot).toBeUndefined();
    expect(parsed.data.droppedFields).toContain("messagesSnapshot");
    expect(Buffer.byteLength(writes[0], "utf8")).toBeLessThanOrEqual(
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1,
    );
  });

  it("drops oversized preserved fields when needed to keep runtime events bounded", async () => {
    const writes: string[] = [];
    const oversizedUsage = Object.fromEntries(
      Array.from({ length: 64 }, (_value, index) => [`field-${index}`, "x".repeat(5_000)]),
    );
    const promptCache = { readTokens: 333_824, writeTokens: 51_130 };
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = await expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("model.completed", {
      usage: oversizedUsage,
      promptCache,
      messagesSnapshot: [{ role: "user", content: "x".repeat(32_000) }],
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      promptCache,
    });
    expect(parsed.data.usage).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(
      expect.arrayContaining(["usage", "messagesSnapshot"]),
    );
    expect(Buffer.byteLength(writes[0], "utf8")).toBeLessThanOrEqual(
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1,
    );
  });

  it("preserves usage on non-final oversized runtime completions", async () => {
    const writes: string[] = [];
    const firstUsage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    const secondUsage = { input: 12, output: 3, total: 15 };
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = await expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("model.completed", {
      usage: firstUsage,
      promptCache: { readTokens: 333_824 },
      messagesSnapshot: Array.from({ length: 12 }, (_value, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(32_000)}`,
      })),
    });
    runtimeRecorder.recordEvent("model.completed", {
      usage: secondUsage,
      assistantTexts: ["final answer"],
    });

    expect(writes).toHaveLength(2);
    const first = JSON.parse(writes[0]);
    const second = JSON.parse(writes[1]);
    expect(first.data).toMatchObject({
      truncated: true,
      usage: firstUsage,
      promptCache: { readTokens: 333_824 },
    });
    expect(second.data).toMatchObject({
      usage: secondUsage,
      assistantTexts: ["final answer"],
    });
    expect(second.data.truncated).toBeUndefined();
  });

  it("redacts secrets before preserving usage in truncated runtime events", async () => {
    const writes: string[] = [];
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: (line) => {
          writes.push(line);
        },
        flush: async () => undefined,
      },
    });

    const runtimeRecorder = await expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("model.completed", {
      usage: {
        total: 1,
        note: "Authorization: Bearer sk-inline-secret-token",
        apiKey: "sk-test-secret-token",
        authorization: "Bearer sk-other-secret-token",
      },
      messagesSnapshot: Array.from({ length: 12 }, (_value, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message-${index} ${"x".repeat(32_000)}`,
      })),
    });

    expect(writes).toHaveLength(1);
    const parsed = JSON.parse(writes[0]);
    const preservedUsage = JSON.stringify(parsed.data.usage);
    expect(parsed.data.truncated).toBe(true);
    expect(preservedUsage).toContain("redacted");
    expect(preservedUsage).not.toContain("sk-inline-secret-token");
    expect(preservedUsage).not.toContain("sk-test-secret-token");
    expect(preservedUsage).not.toContain("sk-other-secret-token");
  });

  it("rotates runtime capture at the file budget and keeps newer events", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const maxRuntimeFileBytes = 1_600;
    const firstRecorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile,
      maxRuntimeFileBytes,
    });

    const firstRuntimeRecorder = await expectTrajectoryRuntimeRecorder(firstRecorder);
    for (const marker of ["old-1", "old-2", "old-3"]) {
      firstRuntimeRecorder.recordEvent("prompt.submitted", {
        marker,
        prompt: "x".repeat(260),
      });
    }
    await firstRuntimeRecorder.flush();

    const secondRecorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile,
      maxRuntimeFileBytes,
    });
    const secondRuntimeRecorder = await expectTrajectoryRuntimeRecorder(secondRecorder);
    for (const marker of ["new-1", "new-2", "new-3"]) {
      secondRuntimeRecorder.recordEvent("prompt.submitted", {
        marker,
        prompt: "y".repeat(260),
      });
    }
    await secondRuntimeRecorder.flush();

    const runtimeFile = resolveTrajectoryFilePath({ sessionFile, sessionId: "session-1" });
    const raw = fs.readFileSync(runtimeFile, "utf8");
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(maxRuntimeFileBytes);
    expect(raw).not.toContain("old-1");
    expect(raw).toContain("new-3");
  });

  it.runIf(process.platform !== "win32")(
    "preserves existing trajectory directory permissions",
    async () => {
      const tmpDir = makeTempDir();
      fs.chmodSync(tmpDir, 0o755);
      const sessionFile = path.join(tmpDir, "session.jsonl");
      const recorder = createTrajectoryRuntimeRecorder({
        sessionId: "session-1",
        sessionFile,
        maxRuntimeFileBytes: 1_600,
      });

      const runtimeRecorder = await expectTrajectoryRuntimeRecorder(recorder);
      runtimeRecorder.recordEvent("prompt.submitted", {
        prompt: "hello",
      });
      await runtimeRecorder.flush();

      expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o755);
    },
  );

  it("merges stale recorder flushes with newer runtime events", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const staleRecorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile,
      maxRuntimeFileBytes: 2_400,
    });

    const staleRuntimeRecorder = await expectTrajectoryRuntimeRecorder(staleRecorder);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    staleRuntimeRecorder.recordEvent("prompt.submitted", {
      marker: "old-recorder",
      prompt: "x".repeat(260),
    });

    const newerRecorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile,
      maxRuntimeFileBytes: 2_400,
    });
    const newerRuntimeRecorder = await expectTrajectoryRuntimeRecorder(newerRecorder);
    newerRuntimeRecorder.recordEvent("prompt.submitted", {
      marker: "new-recorder",
      prompt: "y".repeat(260),
    });
    vi.useRealTimers();
    await newerRuntimeRecorder.flush();
    await staleRuntimeRecorder.flush();

    const runtimeFile = resolveTrajectoryFilePath({ sessionFile, sessionId: "session-1" });
    const raw = fs.readFileSync(runtimeFile, "utf8");
    expect(raw).toContain("old-recorder");
    expect(raw).toContain("new-recorder");
    expect(raw.indexOf("old-recorder")).toBeLessThan(raw.indexOf("new-recorder"));
  });

  it("rejects a late flush after its canonical path has been retired", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile,
      maxRuntimeFileBytes: 2_400,
    });
    const runtimeRecorder = await expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("prompt.submitted", { marker: "should-not-land" });

    const runtimeFile = resolveTrajectoryFilePath({ sessionFile, sessionId: "session-1" });
    const canonicalPath = canonicalizeTrajectoryPath(runtimeFile);
    await withTrajectoryPathLock(canonicalPath, () => {
      claimTrajectoryPathIncarnation(canonicalPath, {
        retired: true,
        ownerSessionId: "session-1",
      });
    });

    await runtimeRecorder.flush();

    expect(fs.existsSync(runtimeFile)).toBe(false);
  });

  it("keeps a writer evicted from the process cache invalidated once its path is retired", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session-evict.jsonl");
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "evict-session",
      sessionFile,
      maxRuntimeFileBytes: 2_400,
    });
    const runtimeRecorder = await expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("prompt.submitted", { marker: "first" });
    await runtimeRecorder.flush();

    // Drive MAX_TRAJECTORY_WRITERS eviction so the writers-map entry for
    // "evict-session" is dropped, while this test keeps its own direct
    // reference to the writer exactly as an abandoned closure would.
    for (let index = 0; index < 100; index += 1) {
      await expectTrajectoryRuntimeRecorder(
        createTrajectoryRuntimeRecorder({
          sessionId: `evict-filler-${index}`,
          sessionFile: path.join(tmpDir, `evict-filler-${index}.jsonl`),
          maxRuntimeFileBytes: 2_400,
        }),
      );
    }

    const runtimeFile = resolveTrajectoryFilePath({ sessionFile, sessionId: "evict-session" });
    const canonicalPath = canonicalizeTrajectoryPath(runtimeFile);
    await withTrajectoryPathLock(canonicalPath, () => {
      claimTrajectoryPathIncarnation(canonicalPath, {
        retired: true,
        ownerSessionId: "evict-session",
      });
      // Mirror what a real sessions.delete does inside the same locked turn:
      // retire the generation, then remove the artifact it protects.
      fs.rmSync(runtimeFile, { force: true });
    });

    runtimeRecorder.recordEvent("prompt.submitted", { marker: "late-after-eviction" });
    await runtimeRecorder.flush();

    expect(fs.existsSync(runtimeFile)).toBe(false);
  });

  it("reuses the same lease incarnation when a live writer is evicted and recreated", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session-reuse.jsonl");
    const runtimeFile = resolveTrajectoryFilePath({ sessionFile, sessionId: "reuse-session" });

    const recorderA = createTrajectoryRuntimeRecorder({
      sessionId: "reuse-session",
      sessionFile,
      maxRuntimeFileBytes: 2_400,
    });
    await expectTrajectoryRuntimeRecorder(recorderA);
    const leaseAfterA = await acquireTrajectoryWriterLease({
      sessionId: "reuse-session",
      candidatePath: runtimeFile,
    });
    if (leaseAfterA.status !== "acquired") {
      throw new Error("expected reconnecting owner to reuse its acquired lease");
    }
    const incarnationAfterA = leaseAfterA.incarnation;

    for (let index = 0; index < 100; index += 1) {
      await expectTrajectoryRuntimeRecorder(
        createTrajectoryRuntimeRecorder({
          sessionId: `reuse-filler-${index}`,
          sessionFile: path.join(tmpDir, `reuse-filler-${index}.jsonl`),
          maxRuntimeFileBytes: 2_400,
        }),
      );
    }

    const recorderB = createTrajectoryRuntimeRecorder({
      sessionId: "reuse-session",
      sessionFile,
      maxRuntimeFileBytes: 2_400,
    });
    const runtimeRecorderB = await expectTrajectoryRuntimeRecorder(recorderB);
    const leaseAfterB = await acquireTrajectoryWriterLease({
      sessionId: "reuse-session",
      candidatePath: runtimeFile,
    });
    if (leaseAfterB.status !== "acquired") {
      throw new Error("expected reconnecting owner to reuse its acquired lease");
    }
    const incarnationAfterB = leaseAfterB.incarnation;

    // Eviction+recreation for the *same* still-live session must not spuriously
    // claim a fresh incarnation — it is the same owner reconnecting, not a new epoch.
    expect(incarnationAfterB).toBe(incarnationAfterA);

    runtimeRecorderB.recordEvent("prompt.submitted", { marker: "reused-writer" });
    await runtimeRecorderB.flush();
    expect(fs.readFileSync(runtimeFile, "utf8")).toContain("reused-writer");
  });

  it("keeps a writer held past its retirement's tombstone reap invalidated against a fresh claim", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session-reap.jsonl");
    const runtimeFile = resolveTrajectoryFilePath({ sessionFile, sessionId: "reap-session" });
    const canonicalPath = canonicalizeTrajectoryPath(runtimeFile);

    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "reap-session",
      sessionFile,
      maxRuntimeFileBytes: 2_400,
    });
    const runtimeRecorder = await expectTrajectoryRuntimeRecorder(recorder);
    runtimeRecorder.recordEvent("prompt.submitted", { marker: "stale-before-reap" });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    // Retire exactly like a delete would, then remove the file it protected.
    await withTrajectoryPathLock(canonicalPath, () => {
      claimTrajectoryPathIncarnation(canonicalPath, {
        retired: true,
        ownerSessionId: "reap-session",
      });
    });
    fs.rmSync(runtimeFile, { force: true });

    // Past the 5-minute retired grace period: the registry entry reaps,
    // losing all local memory of this path's prior incarnation.
    vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
    reapRetiredTrajectoryPathEntries();
    vi.useRealTimers();

    // A fresh, unrelated claim on the same (now-reaped) canonical path must
    // land on a process-unique incarnation the pre-reap stale writer can
    // never match, even though the per-path registry has no memory of it
    // and would otherwise restart local numbering from scratch (P1-B).
    const freshLease = await acquireTrajectoryWriterLease({
      sessionId: "post-reap-owner",
      candidatePath: runtimeFile,
    });
    if (freshLease.status !== "acquired") {
      throw new Error("expected a fresh claim on the reaped path to be acquired");
    }
    expect(freshLease.filePath).toBe(runtimeFile);

    await runtimeRecorder.flush();

    expect(fs.existsSync(runtimeFile)).toBe(false);
  });

  it("does not leave an orphaned pointer when a claim's publish would land after a concurrent delete retires the path", async () => {
    const tmpDir = makeTempDir();
    const sessionId = "race-a-session";
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const storePath = path.join(tmpDir, "sessions.json");
    const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);

    // Wraps the real acquireTrajectoryWriterLease so this test controls
    // exactly when createTrajectoryRuntimeRecorder's continuation resumes
    // after the claim (and, once fixed, its bundled publish) settle — the
    // window the round-4 finding is about. Old code's onClaimed never fires
    // (the parameter did not exist yet), so old code's publish still runs in
    // that continuation, unguarded, after this artificial pause.
    const realAcquire = writerLifecycle.acquireTrajectoryWriterLease;
    let releaseContinuation: () => void = () => {};
    const continuationGate = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });
    const acquireSpy = vi
      .spyOn(writerLifecycle, "acquireTrajectoryWriterLease")
      .mockImplementation(async (params) => {
        const lease = await realAcquire(params);
        await continuationGate;
        return lease;
      });

    try {
      const recorderPromise = createTrajectoryRuntimeRecorder({ sessionId, sessionFile });

      // Let the real claim (and, with the fix, its bundled publish) settle
      // before the artificial pause; only createTrajectoryRuntimeRecorder's
      // resumption is held back from here.
      await new Promise<void>((resolve) => {
        setImmediate(() => resolve());
      });

      await removeSessionTrajectoryArtifacts({
        sessionId,
        sessionFile,
        storePath,
        restrictToStoreDir: true,
        disposal: { mode: "tombstone", reason: "deleted" },
      });

      releaseContinuation();
      await recorderPromise;

      await new Promise<void>((resolve) => {
        setImmediate(() => resolve());
      });
      // The stale claim's publish must never recreate the pointer at its
      // original path — the path stays free, tombstoned by the delete above.
      expectTombstoned(pointerPath, "deleted");
    } finally {
      acquireSpy.mockRestore();
    }
  });

  it("keeps colliding sanitized session ids in separate files under an override directory", async () => {
    const tmpDir = makeTempDir();
    const trajectoryDir = path.join(tmpDir, "traces");
    const env = { OPENCLAW_TRAJECTORY_DIR: trajectoryDir };
    const runtimeRecorder1 = await expectTrajectoryRuntimeRecorder(
      createTrajectoryRuntimeRecorder({
        env,
        sessionId: "abc*def",
        maxRuntimeFileBytes: 2_400,
      }),
    );
    const runtimeRecorder2 = await expectTrajectoryRuntimeRecorder(
      createTrajectoryRuntimeRecorder({
        env,
        sessionId: "abc_def",
        maxRuntimeFileBytes: 2_400,
      }),
    );

    expect(runtimeRecorder1.filePath).not.toBe(runtimeRecorder2.filePath);

    runtimeRecorder1.recordEvent("prompt.submitted", { marker: "owner-1" });
    runtimeRecorder2.recordEvent("prompt.submitted", { marker: "owner-2" });
    await runtimeRecorder1.flush();
    await runtimeRecorder2.flush();

    const raw1 = fs.readFileSync(runtimeRecorder1.filePath, "utf8");
    const raw2 = fs.readFileSync(runtimeRecorder2.filePath, "utf8");
    expect(raw1).toContain("owner-1");
    expect(raw1).not.toContain("owner-2");
    expect(raw2).toContain("owner-2");
    expect(raw2).not.toContain("owner-1");
  });

  it("keeps colliding sanitized session ids in separate files under the no-sessionFile cwd fallback", async () => {
    const tmpDir = makeTempDir();
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    try {
      const runtimeRecorder1 = await expectTrajectoryRuntimeRecorder(
        createTrajectoryRuntimeRecorder({
          sessionId: "abc*def",
          maxRuntimeFileBytes: 2_400,
        }),
      );
      const runtimeRecorder2 = await expectTrajectoryRuntimeRecorder(
        createTrajectoryRuntimeRecorder({
          sessionId: "abc_def",
          maxRuntimeFileBytes: 2_400,
        }),
      );

      expect(runtimeRecorder1.filePath).not.toBe(runtimeRecorder2.filePath);

      runtimeRecorder1.recordEvent("prompt.submitted", { marker: "owner-1" });
      runtimeRecorder2.recordEvent("prompt.submitted", { marker: "owner-2" });
      await runtimeRecorder1.flush();
      await runtimeRecorder2.flush();

      const raw1 = fs.readFileSync(runtimeRecorder1.filePath, "utf8");
      const raw2 = fs.readFileSync(runtimeRecorder2.filePath, "utf8");
      expect(raw1).toContain("owner-1");
      expect(raw1).not.toContain("owner-2");
      expect(raw2).toContain("owner-2");
      expect(raw2).not.toContain("owner-1");
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")(
    "refuses runtime capture through symlinked parent directories",
    async () => {
      const tmpDir = makeTempDir();
      const targetDir = path.join(tmpDir, "target");
      const linkDir = path.join(tmpDir, "link");
      fs.mkdirSync(targetDir);
      fs.symlinkSync(targetDir, linkDir);
      const recorder = createTrajectoryRuntimeRecorder({
        sessionId: "session-1",
        sessionFile: path.join(linkDir, "session.jsonl"),
        maxRuntimeFileBytes: 2_400,
      });

      const runtimeRecorder = await expectTrajectoryRuntimeRecorder(recorder);
      runtimeRecorder.recordEvent("prompt.submitted", {
        prompt: "hello",
      });
      await runtimeRecorder.flush();

      expect(fs.existsSync(path.join(targetDir, "session.trajectory.jsonl"))).toBe(false);
    },
  );

  it("describes queued writer state for cleanup timeout logs", async () => {
    const recorder = createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: () => "queued",
        flush: async () => undefined,
        describeQueue: () => ({
          pendingWrites: 2,
          queuedBytes: 256,
          activeOperation: "file-append",
          activeWriteBytes: 128,
          maxFileBytes: 1024,
          maxQueuedBytes: 1024,
          yieldBeforeWrite: true,
        }),
      },
    });

    const runtimeRecorder = await expectTrajectoryRuntimeRecorder(recorder);

    expect(runtimeRecorder.describeFlushState()).toBe(
      "pendingWrites=2 queuedBytes=256 activeOperation=file-append yieldBeforeWrite=true activeWriteBytes=128 maxQueuedBytes=1024 maxFileBytes=1024",
    );
  });

  it("writes a session-adjacent pointer when using an override directory", async () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const trajectoryDir = path.join(tmpDir, "traces");
    const recorder = createTrajectoryRuntimeRecorder({
      env: { OPENCLAW_TRAJECTORY_DIR: trajectoryDir },
      sessionId: "session-1",
      sessionFile,
      writer: {
        filePath: path.join(trajectoryDir, "session-1.jsonl"),
        write: () => undefined,
        flush: async () => undefined,
      },
    });

    await expectTrajectoryRuntimeRecorder(recorder);
    const pointer = JSON.parse(
      fs.readFileSync(resolveTrajectoryPointerFilePath(sessionFile), "utf8"),
    ) as { runtimeFile?: string };
    expect(pointer.runtimeFile).toBe(path.join(trajectoryDir, "session-1.jsonl"));
  });

  it("keeps pointer write flags usable when O_NOFOLLOW is unavailable", () => {
    expect(
      resolveTrajectoryPointerOpenFlags({
        O_CREAT: 0x01,
        O_TRUNC: 0x02,
        O_WRONLY: 0x04,
      }),
    ).toBe(0x07);
  });

  it("does not record runtime events when explicitly disabled", async () => {
    const recorder = await createTrajectoryRuntimeRecorder({
      env: {
        OPENCLAW_TRAJECTORY: "0",
      },
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      writer: {
        filePath: "/tmp/session.trajectory.jsonl",
        write: () => undefined,
        flush: async () => undefined,
      },
    });

    expect(recorder).toBeNull();
  });
});
