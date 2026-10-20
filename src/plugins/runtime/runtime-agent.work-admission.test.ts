import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getActiveNativeAttempt } from "../../agents/embedded-agent-runner/run-state.js";
import {
  attachActiveEmbeddedRun,
  detachActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
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

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-plugin-session-admission-");
let storePath: string;
const sessionKey = "agent:main:voice:caller";
const sessionId = "voice-session-id";
const session = createRuntimeAgent().session;
const scope = (key = sessionKey) => ({ storePath, sessionKey: key });
const seed = (key = sessionKey, id = sessionId) =>
  session.upsertSessionEntry({
    ...scope(key),
    entry: { sessionId: id, updatedAt: Date.now() },
  });
const work = (run: () => Promise<unknown>) => session.runWithWorkAdmission(scope(), run);
const mutate = (run: () => Promise<unknown>, prepare?: () => Promise<void>) =>
  runSessionMutation({
    scope: storePath,
    identities: [sessionKey, sessionId],
    policy: "wait",
    run,
    prepare,
  });

afterEach(() => {
  vi.mocked(readAgentDeletionJournalStatusInWorker).mockClear();
  clearRuntimeConfigSnapshot();
});

beforeEach(async () => {
  setRuntimeConfigSnapshot({});
  storePath = path.join(sessionDirs.make(), "sessions.json");
  await seed();
});

it("rejects pending agent deletion before plugin work", async () => {
  const run = vi.fn(async () => {});
  vi.mocked(readAgentDeletionJournalStatusInWorker).mockResolvedValueOnce("pending");
  await expect(work(run)).rejects.toThrow("deletion is in progress");
  expect(readAgentDeletionJournalStatusInWorker).toHaveBeenCalledWith(
    "main",
    expect.anything(),
    expect.any(AbortSignal),
  );
  expect(run).not.toHaveBeenCalled();
});

it("admits fresh work and protects session creation inside the callback", async () => {
  const freshKey = "agent:main:voice:fresh";
  const freshId = "fresh-session-id";

  await session.runWithWorkAdmission(scope(freshKey), async () => {
    const claim = getCurrentSessionControllerClaim();
    expect(claim?.operation).toBeUndefined();
    await seed(freshKey, freshId);
    await withSessionTurn({ ...scope(freshKey), sessionId: freshId }, async (operation) => {
      expect(operation?.sessionId).toBe(freshId);
      expect(getCurrentSessionControllerClaim()).toBe(claim);
      const native = createEmbeddedRunHandle({ runId: "fresh-sdk-native" });
      attachActiveEmbeddedRun(freshId, native, freshKey, undefined, "main", operation);
      try {
        expect(getActiveNativeAttempt(freshId)).toBe(native);
      } finally {
        detachActiveEmbeddedRun(freshId, native);
      }
    });
    expect(claim?.operation?.result).toBeNull();
  });

  expect(session.getSessionEntry(scope(freshKey))?.sessionId).toBe(freshId);
});

it("permits a wait-policy mutation inside the retained plugin callback", async () => {
  const mutation = vi.fn(async () => "updated");
  await expect(work(() => mutate(mutation))).resolves.toBe("updated");
  expect(mutation).toHaveBeenCalledOnce();
});

it("retains plugin callback custody until the callback returns", async () => {
  const started = createDeferred();
  const release = createDeferred();
  const mutationStarted = createDeferred();
  let callbackReturned = false;
  const mutated = vi.fn(async () => expect(callbackReturned).toBe(true));
  const running = work(async () => {
    started.resolve();
    await release.promise;
    callbackReturned = true;
  });
  await started.promise;
  const mutation = mutate(mutated, async () => mutationStarted.resolve());
  try {
    await mutationStarted.promise;
    expect(mutated).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await running;
    await mutation;
  }
  expect(mutated).toHaveBeenCalledOnce();
});
