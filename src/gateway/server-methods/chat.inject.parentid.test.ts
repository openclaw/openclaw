import { afterEach, beforeEach, expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
} from "../managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../managed-image-record-store.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
async function createFixture() {
  state = await createOpenClawTestState({ label: "chat-inject", scenario: "minimal" });
  const scope = {
    dir: state.stateDir,
    agentId: "main",
    sessionKey: "main",
    sessionId: "inject-session",
    storePath: state.statePath("sessions.json"),
  };
  setRuntimeConfigSnapshot({});
  await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
  return scope;
}

let fixture: Awaited<ReturnType<typeof createFixture>>;
const updates: Array<{ message?: unknown; sessionKey?: string; agentId?: string }> = [];
let unsubscribe = () => {};
beforeEach(async () => {
  fixture = await createFixture();
  updates.length = 0;
  unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
});
afterEach(async () => {
  unsubscribe();
  await state.cleanup();
});

async function readLastTranscriptRecord(): Promise<Record<string, unknown>> {
  const events = await loadTranscriptEvents(fixture);
  expect(events.length).toBeGreaterThanOrEqual(2);
  return events.at(-1) as Record<string, unknown>;
}

it.for([false, true])(
  "joins committed media before publication or callback failure (%s)",
  async (failCallback, test) => {
    const entered = createDeferred();
    const release = createDeferred();
    const bytes = createSolidPngBuffer(1, 1, { r: 34, g: 51, b: 68 });
    let pending: ReturnType<typeof appendInjectedAssistantMessageToTranscript> | undefined;
    try {
      const blocks = await createManagedOutgoingMediaBlocks({
        sessionKey: fixture.sessionKey,
        agentId: fixture.agentId,
        stateDir: fixture.dir,
        items: [{ url: `data:image/png;base64,${bytes.toString("base64")}`, trustedLocal: false }],
      });
      pending = appendInjectedAssistantMessageToTranscript({
        ...fixture,
        message: "Image ready",
        content: [{ type: "text", text: "Image ready" }, ...blocks],
        stopReason: "aborted",
        onMessageCommitted: (receipt, acceptCompletion) => {
          acceptCompletion(async () => {
            entered.resolve();
            await release.promise;
            expect(
              await attachManagedOutgoingMediaToMessage({
                messageId: receipt.messageId,
                blocks,
                stateDir: fixture.dir,
              }),
            ).toBe(true);
          });
          if (failCallback) {
            throw new Error("Synthetic callback failure after custody acceptance");
          }
        },
      });
      await racePromiseWithAbortSignal(
        awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Injection never accepted media completion",
        ),
        test.signal,
      );
      expect(updates).toEqual([]);
      release.resolve();
      expect(await pending).toMatchObject({
        ok: !failCallback,
        ...(!failCallback ? { message: { stopReason: "aborted" } } : {}),
      });
      expect(updates).toHaveLength(failCallback ? 0 : 1);
      const entries = await listManagedImageRecordEntries({ stateDir: fixture.dir });
      expect(entries.map(({ record }) => record)).toMatchObject([
        { messageId: expect.any(String), retentionClass: "history" },
      ]);
      expect((await readLastTranscriptRecord()).message).toMatchObject({
        content: [{ type: "text", text: "Image ready" }],
        openclawDisplayContent: [{ type: "text", text: "Image ready" }, ...blocks],
        stopReason: "aborted",
      });
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  },
);

it("preserves injected source text through its persisted transcript owner", async () => {
  const fakeApiKey = "sk-proj-FAKEKEYFORTESTINGONLY1234567890";
  const appended = await appendInjectedAssistantMessageToTranscript({
    ...fixture,
    sessionKey: "global",
    message: `Here is your key: ${fakeApiKey}`,
    config: {},
  });

  expect(appended.ok).toBe(true);
  expect(JSON.stringify(appended.message)).toContain(fakeApiKey);
  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({ sessionKey: "agent:main:main", agentId: "main" });

  const last = await readLastTranscriptRecord();
  expect(JSON.stringify(last.message)).toContain(fakeApiKey);
  expect(updates[0]?.message).toEqual(last.message);
});
