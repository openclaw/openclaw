import "../../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { withIncognitoSessionActor } from "../../config/sessions/session-incognito-binding.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  openIncognitoTestActor,
  useIncognitoNoHostSql,
} from "../../state/openclaw-agent-execution-incognito.test-support.js";
import { prepareChatMetadataSessionRead } from "./chat-metadata-session-read.js";
import { resolveDurableChatClaim } from "./chat-restart-recovery.js";
import { prepareExpectedLeafActive } from "./chat-send-active-leaf.js";

// mock-isolation: Recovery execution is external to the retained admission/reload contract.
vi.mock("../../agents/main-session-recovery/main-session-restart-recovery.js", () => ({
  retryRestartAbortedMainSessionRecovery: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
beforeAll(async () => {
  actor = await openIncognitoTestActor(
    { OPENCLAW_STATE_DIR: dirs.make("chat-incognito-admission-") },
    authority,
  );
});
afterAll(async () => actor?.close());
useIncognitoNoHostSql();

async function create(name: string, fields: Partial<SessionEntry> = {}) {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const result = await actor.sessions.create(authority, {
    sessionKey,
    entry: { sessionId: name, updatedAt: 1, incognito: true, ...fields },
  });
  assert(result.entry);
  return { canonicalKey: sessionKey, entry: result.entry, storePath: actor.path };
}

it("fences stop against the exact active leaf across a later append", async () => {
  const session = await create("stop-leaf");
  await withIncognitoSessionActor(actor, async () => {
    const assertLeaf = await prepareExpectedLeafActive(
      session,
      "main",
      null,
      session.entry.sessionId,
    );
    assert(assertLeaf);
    assertLeaf();
    await actor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        sessionKey: session.canonicalKey,
        sessionId: session.entry.sessionId,
        message: { role: "user", content: "new branch input", timestamp: 1 },
      },
    });
    expect(assertLeaf).toThrow("active-leaf-changed");
  });
});

it("rejects a retained stop after lifecycle rotation even if the leaf is still empty", async () => {
  const session = await create("stop-generation");
  await withIncognitoSessionActor(actor, async () => {
    const assertLeaf = await prepareExpectedLeafActive(
      session,
      "main",
      null,
      session.entry.sessionId,
    );
    assert(assertLeaf);
    const rotated = await actor.sessions.transcript(authority, {
      type: "session.manager.transcript.branch",
      input: {
        sessionKey: session.canonicalKey,
        command: {
          type: "session.transcript.branch",
          input: {
            scope: {
              agentId: "main",
              storePath: actor.path,
              sessionKey: session.canonicalKey,
              sessionId: session.entry.sessionId,
            },
            branch: { sessionId: "stop-successor", events: [] },
            expectedLifecycleRevision: session.entry.lifecycleRevision,
          },
        },
      },
    });
    assert(rotated.ok);
    expect(assertLeaf).toThrow();
  });
});

it("retains metadata authority through an awaited provider preparation", async () => {
  const session = await create("metadata", { modelOverride: "first" });
  await withIncognitoSessionActor(actor, async () => {
    const prepared = await prepareChatMetadataSessionRead({
      cfg: {},
      agentId: "main",
      sessionKey: session.canonicalKey,
      assertRequestCurrent() {},
    });
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const reading = prepared.withCurrent(async () => {
      entered.resolve();
      await resume.promise;
    });
    try {
      await awaitGateBeforeSettlement(entered.promise, reading, "metadata preparation");
      await patchSessionEntryCore(
        { agentId: "main", storePath: actor.path, sessionKey: session.canonicalKey },
        () => ({ modelOverride: "second" }),
      );
      resume.resolve();
      await expect(reading).rejects.toThrow("Session changed");
      expect(prepared.beforeRequest).toThrow("Session changed");
    } finally {
      resume.resolve();
      await Promise.allSettled([reading]);
      prepared.release();
    }
  });
});

it("joins an asynchronous same-process recovery reload before classifying the claim", async () => {
  const entry: SessionEntry = {
    sessionId: "recovery",
    updatedAt: Date.now(),
    abortedLastRun: true,
    restartRecoveryDeliveryRunId: "recovery-run",
    restartRecoveryDeliverySourceRunId: "input-run",
  };
  const entered = createDeferred<void>();
  const resume = createDeferred<SessionEntry>();
  const reloadEntry = vi.fn(() => {
    entered.resolve();
    return resume.promise;
  });
  const result = resolveDurableChatClaim({
    canonicalSessionKey: "agent:main:dashboard:incognito-recovery",
    cfg: {},
    clientRunId: "input-run",
    entry,
    persistedSessionKey: "agent:main:dashboard:incognito-recovery",
    storePath: actor.path,
    recoveryRuntime: {
      prepareRestartRecovery: () => undefined,
      async dispatchSessionMethod() {
        throw new Error("Unexpected recovery dispatch");
      },
      async dispatchAgent() {
        throw new Error("Unexpected agent dispatch");
      },
      async waitForAgent() {
        throw new Error("Unexpected agent wait");
      },
      async sendRecoveryNotice() {
        throw new Error("Unexpected recovery notice");
      },
    },
    reloadEntry,
    warn: vi.fn(),
  });
  assert(result instanceof Promise);
  await awaitGateBeforeSettlement(entered.promise, result, "recovery reload");
  resume.resolve({ ...entry, abortedLastRun: false });
  await expect(result).resolves.toEqual({ kind: "accepted" });
  expect(reloadEntry).toHaveBeenCalledOnce();
});
