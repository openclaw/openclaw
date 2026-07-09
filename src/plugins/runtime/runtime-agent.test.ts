import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import { createRuntimeAgent } from "./runtime-agent.js";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("plugin runtime session work admission", () => {
  let tempDir: string;
  let storePath: string;
  const sessionKey = "agent:main:voice:caller";
  const sessionId = "voice-session-id";

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-session-admission-"));
    storePath = path.join(tempDir, "sessions.json");
    await createRuntimeAgent().session.upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId, updatedAt: Date.now() },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects an archived session before running admitted work", async () => {
    const runtime = createRuntimeAgent();
    await runtime.session.patchSessionEntry({
      storePath,
      sessionKey,
      update: () => ({ archivedAt: Date.now() }),
    });
    let ran = false;

    await expect(
      runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async () => {
        ran = true;
      }),
    ).rejects.toThrow(`Session "${sessionKey}" is archived`);
    expect(ran).toBe(false);
  });

  it("waits for a queued archive mutation and rejects the stale start", async () => {
    const runtime = createRuntimeAgent();
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
      },
      run: async () => {
        await runtime.session.patchSessionEntry({
          storePath,
          sessionKey,
          update: () => ({ archivedAt: Date.now() }),
        });
      },
    });
    await mutationStarted.promise;

    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async () => {});
    releaseMutation.resolve();
    await mutation;

    await expect(work).rejects.toThrow(`Session "${sessionKey}" is archived`);
  });

  it("admits fresh work and protects session creation inside the callback", async () => {
    const runtime = createRuntimeAgent();
    const freshKey = "agent:main:voice:fresh";
    const freshId = "fresh-session-id";

    await runtime.session.runWithWorkAdmission({ storePath, sessionKey: freshKey }, async () => {
      await runtime.session.upsertSessionEntry({
        storePath,
        sessionKey: freshKey,
        entry: { sessionId: freshId, updatedAt: Date.now() },
      });
    });

    expect(runtime.session.getSessionEntry({ storePath, sessionKey: freshKey })?.sessionId).toBe(
      freshId,
    );
  });

  it("holds admission through the callback and relays lifecycle interruption", async () => {
    const runtime = createRuntimeAgent();
    const workStarted = createDeferred();
    let admittedSignal: AbortSignal | undefined;
    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async (signal) => {
      admittedSignal = signal;
      workStarted.resolve();
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    await workStarted.promise;

    await interruptSessionWorkAdmissions({
      scope: storePath,
      identities: [sessionKey, sessionId],
    });
    await work;

    expect(admittedSignal?.aborted).toBe(true);
  });
});
