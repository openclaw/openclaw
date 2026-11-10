import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getActiveNativeAttempt } from "../../agents/embedded-agent-runner/run-state.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  getCurrentSessionControllerClaim,
  runSessionMutation,
} from "../../sessions/session-controller.lifecycle.js";
import { readAgentDeletionJournalStatusInWorker } from "../../state/agent-deletion-journal.read.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createRuntimeAgent } from "./runtime-agent.js";

vi.mock("../../state/agent-deletion-journal.read.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/agent-deletion-journal.read.js")>()),
  readAgentDeletionJournalStatusInWorker: vi.fn(async () => "absent"),
}));

describe("plugin runtime session work admission", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-plugin-session-admission-");
  let storePath: string;
  const sessionKey = "agent:main:voice:caller";
  const sessionId = "voice-session-id";

  afterEach(() => {
    vi.mocked(readAgentDeletionJournalStatusInWorker).mockClear();
    clearRuntimeConfigSnapshot();
  });

  beforeEach(async () => {
    setRuntimeConfigSnapshot({});
    const tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "sessions.json");
    await createRuntimeAgent().session.upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId, updatedAt: Date.now() },
    });
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

  it("rejects a persisted pending agent deletion before running plugin work", async () => {
    const runtime = createRuntimeAgent();
    const run = vi.fn(async () => {});
    vi.mocked(readAgentDeletionJournalStatusInWorker).mockResolvedValueOnce("pending");
    await expect(
      runtime.session.runWithWorkAdmission({ storePath, sessionKey }, run),
    ).rejects.toThrow("deletion is in progress");
    expect(readAgentDeletionJournalStatusInWorker).toHaveBeenCalledWith(
      "main",
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("admits fresh work and protects session creation inside the callback", async () => {
    const runtime = createRuntimeAgent();
    const freshKey = "agent:main:voice:fresh";
    const freshId = "fresh-session-id";

    await runtime.session.runWithWorkAdmission({ storePath, sessionKey: freshKey }, async () => {
      const claim = getCurrentSessionControllerClaim();
      expect(claim?.operation).toBeUndefined();
      await runtime.session.upsertSessionEntry({
        storePath,
        sessionKey: freshKey,
        entry: { sessionId: freshId, updatedAt: Date.now() },
      });
      await withSessionTurn(
        { storePath, sessionKey: freshKey, sessionId: freshId },
        async (operation) => {
          expect(operation?.sessionId).toBe(freshId);
          expect(getCurrentSessionControllerClaim()).toBe(claim);
          const native = {
            runId: "fresh-sdk-native",
            queueMessage: async () => {},
            isStreaming: () => true,
            isCompacting: () => false,
            abort: () => {},
          };
          attachActiveEmbeddedRun(freshId, native, freshKey, undefined, "main", operation);
          try {
            expect(getActiveNativeAttempt(freshId)).toBe(native);
          } finally {
            detachActiveEmbeddedRun(freshId, native);
          }
        },
      );
      expect(claim?.operation?.result).toBeNull();
    });

    expect(runtime.session.getSessionEntry({ storePath, sessionKey: freshKey })?.sessionId).toBe(
      freshId,
    );
  });

  it("permits a wait-policy mutation inside the retained plugin callback", async () => {
    const runtime = createRuntimeAgent();
    const mutation = vi.fn(async () => "updated");
    await expect(
      runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async () =>
        runSessionMutation({
          scope: storePath,
          identities: [sessionKey, sessionId],
          policy: "wait",
          run: mutation,
        }),
      ),
    ).resolves.toBe("updated");
    expect(mutation).toHaveBeenCalledOnce();
  });

  it("retains plugin callback custody until the callback returns", async () => {
    const runtime = createRuntimeAgent();
    const started = createDeferred();
    const release = createDeferred();
    const mutationStarted = createDeferred();
    let callbackReturned = false;
    const mutated = vi.fn(async () => expect(callbackReturned).toBe(true));
    const work = runtime.session.runWithWorkAdmission({ storePath, sessionKey }, async () => {
      started.resolve();
      await release.promise;
      callbackReturned = true;
    });
    await started.promise;
    const mutation = runSessionMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      policy: "wait",
      prepare: async () => mutationStarted.resolve(),
      run: mutated,
    });
    try {
      await mutationStarted.promise;
      expect(mutated).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await work;
      await mutation;
    }
    expect(mutated).toHaveBeenCalledOnce();
  });
});
