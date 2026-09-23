import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  appendAssistantMirrorMessageByIdentity,
  appendSessionTranscriptMessageByIdentity,
  readVisibleSessionTranscriptMessageEntries,
  type SessionTranscriptAssistantMirrorAppendParams,
} from "./session-transcript-runtime.js";

describe("channel-final transcript mirrors", () => {
  let state: OpenClawTestState;
  let scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string };

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-channel-mirror-", applyEnv: false });
    scope = {
      agentId: "main",
      sessionId: "channel-mirror-session",
      sessionKey: "agent:main:channel-mirror",
      storePath: path.join(state.root, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });

  const append = async (message: Record<string, unknown>, eventId?: string) => {
    const result = await appendSessionTranscriptMessageByIdentity({ ...scope, message, eventId });
    if (!result) {
      throw new Error("Expected the fixture message to append");
    }
    return result;
  };
  const delivery = (id: string, text = "The train leaves at noon.") =>
    ({
      ...scope,
      idempotencyKey: id,
      deliveryMirror: { kind: "channel-final", sourceMessageId: id },
      text,
      updateMode: "none",
    }) satisfies SessionTranscriptAssistantMirrorAppendParams;
  const rows = () =>
    readTranscriptEventRows(
      openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteTranscriptReadScope(scope))),
      scope.sessionId,
    );
  const entries = () => readVisibleSessionTranscriptMessageEntries(scope);

  it("retains both transcript facts and correlates the delivered final answer", async () => {
    await append(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Checking the timetable." },
          {
            type: "text",
            text: "I will check the departure.",
            textSignature: '{"v":1,"id":"commentary","phase":"commentary"}',
          },
          {
            type: "text",
            text: "The train leaves at noon.",
            textSignature: '{"v":1,"id":"answer","phase":"final_answer"}',
          },
        ],
      },
      "assistant-answer",
    );

    await expect(
      appendAssistantMirrorMessageByIdentity(delivery("delivery-one")),
    ).resolves.toMatchObject({ ok: true });

    expect(await entries()).toMatchObject([
      { entryId: "assistant-answer", message: { role: "assistant" } },
      {
        message: {
          model: "delivery-mirror",
          idempotencyKey: "delivery-one",
          content: [{ type: "text", text: "The train leaves at noon." }],
          openclawDeliveryMirror: {
            kind: "channel-final",
            sourceMessageId: "delivery-one",
            sourceAssistantMessageId: "assistant-answer",
          },
        },
      },
    ]);
  });

  it.each([
    { name: "different answer", message: { role: "assistant", content: "A different departure." } },
    { name: "later user turn", message: { role: "user", content: "What about tomorrow?" } },
    {
      name: "another delivery mirror",
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: "The train leaves at noon.",
      },
    },
  ])("leaves the mirror uncorrelated after $name", async ({ message: precedingMessage }) => {
    await append({ role: "assistant", content: "The train leaves at noon." }, "older-answer");
    await append(precedingMessage);

    await appendAssistantMirrorMessageByIdentity(delivery("unmatched-delivery"));

    const message = (await entries()).at(-1)?.message;
    expect(message).toMatchObject({
      model: "delivery-mirror",
      idempotencyKey: "unmatched-delivery",
    });
    expect(message).not.toHaveProperty("openclawDeliveryMirror.sourceAssistantMessageId");
  });

  it("replays the stored mirror unchanged immediately and after a later turn", async () => {
    await append({ role: "assistant", content: "The train leaves at noon." }, "first-answer");
    const request = delivery("stable-delivery");
    const first = await appendAssistantMirrorMessageByIdentity(request);
    const initialRows = rows();

    await expect(appendAssistantMirrorMessageByIdentity(request)).resolves.toEqual(first);
    expect(rows()).toEqual(initialRows);
    await append({ role: "user", content: "And the next train?" });
    await append({ role: "assistant", content: "The next train leaves at two." });
    const laterRows = rows();
    await expect(appendAssistantMirrorMessageByIdentity(request)).resolves.toEqual(first);
    expect(rows()).toEqual(laterRows);
  });

  it.each([
    { name: "text", changes: { text: "The train leaves at three." } },
    {
      name: "source delivery",
      changes: { deliveryMirror: { kind: "channel-final", sourceMessageId: "another-source" } },
    },
  ] satisfies Array<{
    name: string;
    changes: Partial<SessionTranscriptAssistantMirrorAppendParams>;
  }>)(
    "rejects a changed $name under an existing key without changing history",
    async ({ changes }) => {
      await append({ role: "assistant", content: "The train leaves at noon." });
      const request = delivery("conflicting-delivery");
      await appendAssistantMirrorMessageByIdentity(request);
      const before = rows();

      await expect(
        appendAssistantMirrorMessageByIdentity({ ...request, ...changes }),
      ).rejects.toThrow("conflicts with the admitted message");
      expect(rows()).toEqual(before);
    },
  );

  it.each(["The train leaves at noon.", "An unrelated answer."])(
    "does not trust a caller-supplied source identity after %s",
    async (answer) => {
      await append({ role: "assistant", content: answer }, "real-answer");
      const request = {
        ...delivery("forged-delivery"),
        deliveryMirror: {
          kind: "channel-final",
          sourceMessageId: "forged-delivery",
          sourceAssistantMessageId: "caller-forged-answer",
        },
      } satisfies SessionTranscriptAssistantMirrorAppendParams & {
        deliveryMirror: {
          kind: "channel-final";
          sourceMessageId: string;
          sourceAssistantMessageId: string;
        };
      };

      await appendAssistantMirrorMessageByIdentity(request);

      const message = (await entries()).at(-1)?.message;
      expect(message).toMatchObject({
        model: "delivery-mirror",
        idempotencyKey: "forged-delivery",
      });
      expect(message).not.toHaveProperty(
        "openclawDeliveryMirror.sourceAssistantMessageId",
        "caller-forged-answer",
      );
      if (answer === "The train leaves at noon.") {
        expect(message).toHaveProperty(
          "openclawDeliveryMirror.sourceAssistantMessageId",
          "real-answer",
        );
      } else {
        expect(message).not.toHaveProperty("openclawDeliveryMirror.sourceAssistantMessageId");
      }
    },
  );

  it("strips source correlation from a caller-supplied suppressed-final marker", async () => {
    const request = {
      ...delivery("suppressed-delivery"),
      deliveryMirror: {
        kind: "channel-final-suppressed",
        reason: "stale-foreground",
        sourceMessageId: "suppressed-delivery",
        sourceAssistantMessageId: "caller-forged-answer",
      },
    } satisfies SessionTranscriptAssistantMirrorAppendParams & {
      deliveryMirror: { kind: "channel-final-suppressed"; sourceAssistantMessageId: string };
    };

    await appendAssistantMirrorMessageByIdentity(request);

    const message = (await entries()).at(-1)?.message;
    expect(message).toMatchObject({
      idempotencyKey: "suppressed-delivery",
      openclawDeliveryMirror: { kind: "channel-final-suppressed", reason: "stale-foreground" },
    });
    expect(message).not.toHaveProperty("openclawDeliveryMirror.sourceAssistantMessageId");
  });

  it("preserves a fieldless mirror when replay follows a newly matching assistant", async () => {
    const request = delivery("fieldless-delivery");
    const original = await appendAssistantMirrorMessageByIdentity(request);
    expect(original).toMatchObject({ ok: true });
    expect((await entries())[0]?.message).not.toHaveProperty(
      "openclawDeliveryMirror.sourceAssistantMessageId",
    );
    await append(
      { role: "assistant", content: "The train leaves at noon." },
      "later-matching-answer",
    );
    const before = rows();

    await expect(appendAssistantMirrorMessageByIdentity(request)).resolves.toEqual(original);

    expect(rows()).toEqual(before);
    expect((await entries())[0]?.message).not.toHaveProperty(
      "openclawDeliveryMirror.sourceAssistantMessageId",
    );
  });

  it("correlates identical answers to their own distinct turns", async () => {
    await append({ role: "assistant", content: "The train leaves at noon." }, "answer-one");
    await appendAssistantMirrorMessageByIdentity(delivery("delivery-one"));
    await append({ role: "user", content: "Please confirm the departure again." });
    await append({ role: "assistant", content: "The train leaves at noon." }, "answer-two");
    await appendAssistantMirrorMessageByIdentity(delivery("delivery-two"));

    expect((await entries()).filter((entry) => entry.idempotencyKey)).toMatchObject([
      { message: { openclawDeliveryMirror: { sourceAssistantMessageId: "answer-one" } } },
      { message: { openclawDeliveryMirror: { sourceAssistantMessageId: "answer-two" } } },
    ]);
  });

  it("correlates only the selected active branch", async () => {
    await append({ role: "assistant", content: "The train leaves at noon." }, "active-answer");
    await append({ role: "assistant", content: "The train leaves at two." }, "inactive-answer");
    await appendTranscriptEvent(scope, {
      type: "leaf",
      id: "select-active-answer",
      parentId: "inactive-answer",
      targetId: "active-answer",
    });

    await appendAssistantMirrorMessageByIdentity(delivery("branch-delivery"));

    expect((await entries()).at(-1)?.message).toHaveProperty(
      "openclawDeliveryMirror.sourceAssistantMessageId",
      "active-answer",
    );
  });
});
