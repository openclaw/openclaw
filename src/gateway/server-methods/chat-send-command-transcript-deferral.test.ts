import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { setReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import { getMediaDir } from "../../media/store.js";
import { readVisibleSessionTranscriptMessageEntries } from "../../plugin-sdk/session-transcript-runtime.js";
import { markReplyOperationExecutionStarted } from "../../sessions/session-controller.state.js";
import { readAssistantDisplayContent } from "../../shared/assistant-display-content.js";
import { installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import { finalizeChatSendDispatchedReplies } from "./chat-send-reply-finalization.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function readMessages(fixture: Fixture) {
  return (
    await readVisibleSessionTranscriptMessageEntries({
      agentId: fixture.scope.agentId,
      storePath: fixture.scope.storePath,
      sessionKey: fixture.scope.sessionKey,
      sessionId: fixture.scope.sessionId,
    })
  ).map((entry) => entry.message);
}

async function finalizeCommand(fixture: Fixture, payload: ReplyPayload, commandText: string) {
  await finalizeChatSendDispatchedReplies({
    accountId: undefined,
    context: fixture.context,
    emitFirstAssistantServerTiming: () => {},
    terminalEntry: undefined,
    session: {
      agentId: fixture.scope.agentId,
      backingSessionId: fixture.scope.sessionId,
      cfg: fixture.context.getRuntimeConfig(),
      clientRunId: "mid-turn-command-run",
      sessionKey: fixture.scope.sessionKey,
      sessionLoadOptions: {},
      storePath: fixture.scope.storePath,
    },
    deliveredReplies: [{ kind: "final", input: { kind: "raw", payload } }],
    foldCommandBlocks: true,
    persistUserTurnTranscript: async () => undefined,
    runtimeOwnsTranscript: false,
    state: "final",
    commandText,
    suppressReplies: false,
  });
}

function writeTtsAudio() {
  const audioPath = path.join(getMediaDir(), "mid-turn-tts.mp3");
  fs.mkdirSync(path.dirname(audioPath), { recursive: true });
  fs.writeFileSync(audioPath, Buffer.from([0xff, 0xfb, 0x90, 0x00]));
  return audioPath;
}

async function withActiveFixture(
  run: (fixture: Fixture, activeRun: NonNullable<Fixture["activeRun"]>) => Promise<void>,
) {
  const fixture = await createFixture({ active: true });
  const activeRun = fixture.activeRun;
  if (!activeRun) {
    throw new Error("expected the fixture's active run");
  }
  markReplyOperationExecutionStarted(activeRun);
  try {
    await run(fixture, activeRun);
  } finally {
    activeRun.complete();
    await fixture.cleanup();
  }
}

/** A deferred write must not touch the transcript until the owning turn settles. */
async function expectTranscriptUntouchedWhileActive(fixture: Fixture, before: unknown[]) {
  await vi.waitFor(async () => expect(await readMessages(fixture)).toEqual(before), {
    timeout: 5_000,
  });
}

async function expectExchangeAfterSettle(
  fixture: Fixture,
  before: unknown[],
  assertAck: (ack: Record<string, unknown>) => void,
) {
  await vi.waitFor(
    async () => {
      const messages = await readMessages(fixture);
      expect(messages.length).toBe(before.length + 2);
      expect(messages.at(-2)).toMatchObject({
        role: "user",
        content: [{ type: "text", text: expect.stringMatching(/^\//) }],
      });
      const ack = messages.at(-1) as Record<string, unknown>;
      expect(ack).toMatchObject({ role: "assistant", model: "command" });
      for (const message of messages.slice(before.length)) {
        expect(message).not.toHaveProperty("excludeFromContext");
      }
      assertAck(ack);
    },
    { timeout: 15_000 },
  );
}

it("records a mid-turn command exchange through finalization only after the session settles", async () => {
  await withActiveFixture(async (fixture, activeRun) => {
    const before = await readMessages(fixture);
    await finalizeCommand(
      fixture,
      setReplyPayloadMetadata({ text: "Thinking level set to ultra." }, { commandReply: true }),
      "/think ultra",
    );
    await expectTranscriptUntouchedWhileActive(fixture, before);
    activeRun.complete();
    await expectExchangeAfterSettle(fixture, before, (ack) => {
      expect(ack.content).toEqual([{ type: "text", text: "Thinking level set to ultra." }]);
    });
  });
});

it("keeps prepared rich content and its TTS marker on the deferred acknowledgement", async () => {
  await withActiveFixture(async (fixture, activeRun) => {
    const audioPath = writeTtsAudio();
    const before = await readMessages(fixture);
    await finalizeCommand(
      fixture,
      setReplyPayloadMetadata(
        {
          mediaUrl: audioPath,
          trustedLocalMedia: true,
          ttsSupplement: { spokenText: "Hello" },
        },
        { commandReply: true },
      ),
      "/tts audio Hello",
    );
    await expectTranscriptUntouchedWhileActive(fixture, before);
    activeRun.complete();
    await expectExchangeAfterSettle(fixture, before, (ack) => {
      expect(ack.openclawTtsSupplement).toEqual({ textSha256: expect.any(String) });
      // A text-only exchange would lose the audio attachment the reply delivered.
      expect(readAssistantDisplayContent(ack).some((block) => block.type !== "text")).toBe(true);
    });
  });
});
