import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { bindGenericCurrentConversation } from "../../infra/outbound/current-conversation-bindings.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  adminRequestClient,
  callQuestionRpc as call,
  installQuestionTestHooks,
  manager,
  requestParams,
} from "./question.test-support.js";

installQuestionTestHooks();

it("accepts a source answer when routing ignores a cron-run binding", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await upsertSessionEntryCore(
      { agentId: requestParams.agentId, sessionKey: requestParams.sessionKey },
      { sessionId: "ignored-cron-question", updatedAt: 1 },
    );
    const conversation = {
      channel: "webchat",
      accountId: "default",
      conversationId: "ignored-cron-question-source",
    };
    expect(
      await bindGenericCurrentConversation({
        conversation,
        targetSessionKey: "agent:main:cron:job:run:turn",
        targetKind: "session",
      }),
    ).not.toBeNull();
    const requested = await call("question.request", requestParams, {
      client: adminRequestClient,
    });
    const id = (requested[1] as { id: string }).id;
    const answers = { answers: { destination: ["Home"] } };

    expect(
      await call(
        "question.resolve",
        {
          id,
          answers,
          sourceBindingRoutes: [{ conversation, selection: { kind: "none" } }],
        },
        { client: adminRequestClient },
      ),
    ).toEqual([true, { status: "answered", answers }, undefined]);
    expect(manager.get(id)?.status).toBe("answered");
  });
});

it("refuses a source answer after a separate writer removes its durable binding", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await upsertSessionEntryCore(
      { agentId: requestParams.agentId, sessionKey: requestParams.sessionKey },
      { sessionId: "source-binding-question", updatedAt: 1 },
    );
    const conversation = {
      channel: "webchat",
      accountId: "default",
      conversationId: "question-source-binding",
    };
    const targetSessionKey = "agent:main:question-source-binding";
    const binding = await bindGenericCurrentConversation({
      conversation,
      targetSessionKey,
      targetKind: "session",
    });
    expect(binding).not.toBeNull();
    const routeFor = (current: NonNullable<typeof binding>) => [
      {
        conversation,
        selection: {
          kind: "binding" as const,
          bindingId: current.bindingId,
          boundAt: current.boundAt,
          targetSessionKey: current.targetSessionKey,
          targetKind: current.targetKind,
          conversation: current.conversation,
        },
      },
    ];
    const requested = await call("question.request", requestParams, {
      client: adminRequestClient,
    });
    const id = (requested[1] as { id: string }).id;
    const answers = { answers: { destination: ["Home"] } };

    const external = new DatabaseSync(resolveOpenClawStateSqlitePath(state.env));
    try {
      external.exec("DELETE FROM current_conversation_bindings");
    } finally {
      external.close();
    }

    expect(
      await call(
        "question.resolve",
        { id, answers, sourceBindingRoutes: routeFor(binding!) },
        { client: adminRequestClient },
      ),
    ).toMatchObject([
      false,
      undefined,
      { code: "FORBIDDEN", details: { reason: "QUESTION_SOURCE_BINDING_CHANGED" } },
    ]);
    expect(manager.get(id)?.status).toBe("pending");

    vi.setSystemTime(1_001);
    const replacement = await bindGenericCurrentConversation({
      conversation,
      targetSessionKey,
      targetKind: "session",
    });
    expect(replacement).not.toBeNull();
    expect(
      await call(
        "question.resolve",
        { id, answers, sourceBindingRoutes: routeFor(replacement!) },
        { client: adminRequestClient },
      ),
    ).toEqual([true, { status: "answered", answers }, undefined]);
  });
});
