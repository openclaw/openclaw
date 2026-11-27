import { beforeEach, expect, it, vi } from "vitest";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { runPreparedReply } from "./get-reply-run.js";
import "./get-reply-run.runtime-mocks.test-support.js";
import {
  baseParams,
  createPreparedReplyTurn,
  createProviderSurface,
} from "./get-reply-run.test-support.js";
import { buildChannelSourceTurnId } from "./source-turn-id.js";

vi.mock("../../sessions/user-turn-transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../sessions/user-turn-transcript.js")>();
  return {
    ...actual,
    createUserTurnTranscriptRecorder: vi.fn(actual.createUserTurnTranscriptRecorder),
  };
});

const telegramGroup = {
  ...createProviderSurface("telegram"),
  OriginatingChannel: "telegram",
  OriginatingTo: "-100123",
  ChatType: "group",
};
const recorderParams = () => vi.mocked(createUserTurnTranscriptRecorder).mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.mocked(createUserTurnTranscriptRecorder).mockClear();
});

it("lets a durable channel source turn reopen its own cancelled attempt", async () => {
  await runPreparedReply(
    baseParams(createPreparedReplyTurn("fix it please", telegramGroup, { MessageSid: "4242" })),
  );

  expect(recorderParams()).toMatchObject({
    reclaimCancelledSourceTurn: true,
    input: {
      idempotencyKey: buildChannelSourceTurnId({
        provider: "telegram",
        conversationId: "-100123",
        messageId: "4242",
      }),
    },
  });
});

it("keeps turns without a provider message ID on fresh-input custody", async () => {
  await runPreparedReply(baseParams(createPreparedReplyTurn("no source id", telegramGroup)));

  expect(recorderParams()).toBeDefined();
  expect(recorderParams()?.reclaimCancelledSourceTurn).toBeUndefined();
});
