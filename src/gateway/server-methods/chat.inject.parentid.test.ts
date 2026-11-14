import { expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  attachManagedOutgoingMediaToMessage,
  createManagedOutgoingMediaBlocks,
} from "../managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../managed-image-record-store.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";

it("joins committed media before publication and preserves source text", (test) =>
  withOpenClawTestState({ label: "chat-inject", scenario: "minimal" }, async (state) => {
    const fixture = {
      dir: state.stateDir,
      agentId: "main",
      sessionKey: "main",
      sessionId: "inject-session",
      storePath: state.statePath("sessions.json"),
    };
    setRuntimeConfigSnapshot({});
    await replaceSessionEntry(fixture, { sessionId: fixture.sessionId, updatedAt: Date.now() });
    const updates: Array<{ message?: unknown; sessionKey?: string; agentId?: string }> = [];
    const unsubscribe = onSessionTranscriptUpdate((update) => updates.push(update));
    const entered = createDeferred();
    const release = createDeferred();
    const message = "Here is your key: sk-proj-FAKEKEYFORTESTINGONLY1234567890";
    const content = [{ type: "text", text: message }];
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
        sessionKey: "global",
        message,
        config: {},
        content: [...content, ...blocks],
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
        ok: true,
        message: { content: [...content, ...blocks], stopReason: "aborted" },
      });
      expect(updates).toHaveLength(1);
      const entries = await listManagedImageRecordEntries({ stateDir: fixture.dir });
      expect(entries.map(({ record }) => record)).toMatchObject([
        { messageId: expect.any(String), retentionClass: "history" },
      ]);
      const last = (await loadTranscriptEvents(fixture)).at(-1);
      expect(last).toMatchObject({
        message: {
          content,
          openclawDisplayContent: [...content, ...blocks],
          stopReason: "aborted",
        },
      });
      expect(updates[0]).toMatchObject({ sessionKey: "agent:main:main", agentId: "main" });
      expect(last).toHaveProperty("message", updates[0]?.message);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      unsubscribe();
    }
  }));
