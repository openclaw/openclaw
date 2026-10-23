import assert from "node:assert/strict";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  stageSessionPendingInput,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { discardSessionPendingInput } from "../../config/sessions/session-pending-input-withdrawal.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { useUserProfileCatalogForTest } from "../../test-utils/user-profile-catalog.js";
import { installGatewayTestHooks } from "../test-helpers.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";
import type { RespondFn } from "./types.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();
const prepareProfiles = useUserProfileCatalogForTest();
beforeEach(() => prepareProfiles());
type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function send(fixture: Fixture, params: Fixture["params"]) {
  return (await fixture.send(vi.fn<RespondFn>(), undefined, params)).mock.calls[0]!;
}
async function accept(fixture: Fixture, params: Fixture["params"]) {
  expect((await send(fixture, params))[0]).toBe(true);
}
const answered = { details: { reason: "async-question-already-answered" } };

async function questionAnswer(fixture: Fixture, itemId = "audience", eventId?: string) {
  const source = await fixture.withStorage(() =>
    appendTranscriptMessage(fixture.scope, {
      eventId,
      message: {
        role: "assistant",
        content: "Which audience?",
        timestamp: 2,
        openclawAsyncDelivery: { itemId, questions: [{ title: "Which audience?" }] },
      },
    }),
  );
  assert(source, "Expected a persisted question");
  return {
    ...fixture.params,
    replyToId: source.messageId,
    asyncQuestionItemId: itemId,
    message: "> Which audience?\n\nEngineers",
  };
}

// These answer bytes were captured from openclaw@2026.10.6's published storage
// producer (fe06181dc5ecc01cf8904abbfc26925925efefbc). No async answer ID existed.
// The separate release rehearsal migrates its real v25 database through Doctor's
// current maintenance owner; this bounded regression keeps that legacy JSON contract.
it.each(["queued", "saved"] as const)(
  "keeps legacy %s answer bytes authoritative after SQLite reopens",
  async (kind) => {
    await using fixture = await createFixture({ preserveContent: true });
    const questionId = "legacy-question-" + kind;
    const answer = await questionAnswer(fixture, "legacy-" + kind, questionId);
    const runId = "legacy-answer-" + kind;
    const message = {
      role: "user" as const,
      content: "> Which audience?\n\nEngineers",
      timestamp: 3,
      idempotencyKey: runId + ":user",
      __openclaw: { replyToId: questionId },
    };
    if (kind === "queued") {
      const receipt = await stageSessionPendingInput(fixture.scope, {
        runId,
        message,
        assertCurrent() {},
      });
      assert(receipt, "Expected accepted legacy custody");
      receipt.finish("interrupted");
      await receipt.settled?.();
    } else {
      await appendTranscriptMessage(fixture.scope, { message });
    }
    const original = fixture.readTranscript();
    await closeOpenClawAgentDatabaseByPathAsync(
      resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteScope(fixture.scope))),
      fixture.scope.agentId,
    );
    const params = {
      ...answer,
      idempotencyKey: "legacy-duplicate",
      message: "> Which audience?\n\nEveryone",
    };
    const duplicate = await send(fixture, params);
    expect(duplicate[2]).toMatchObject(answered);
    expect(fixture.readTranscript()).toEqual(original);
    if (kind === "queued") {
      expect((await listSessionPendingInputs(fixture.scope)).items[0]?.message).toEqual(message);
      expect(await discardSessionPendingInput(fixture.scope, runId, () => {})).toBe(true);
      const replacement = await send(fixture, {
        ...params,
        idempotencyKey: "legacy-replacement",
      });
      expect(replacement[0]).toBe(true);
    }
  },
);

describe.each(["durable", "memory"] as const)("%s question custody", (storage) => {
  it.each(["cancelled", "interrupted"] as const)("settles as %s", async (disposition) => {
    await using fixture = await createFixture({ storage, preserveContent: true });
    const params = await questionAnswer(fixture);
    await accept(fixture, params);
    const recorder = await fixture.dispatchedRecorder;
    recorder.finishPendingInput?.(disposition);
    await recorder.waitForPendingInputSettlement?.();
    expect((await listSessionPendingInputs(fixture.scope)).items[0]?.state).toBe(disposition);
    const next = await send(fixture, {
      ...params,
      idempotencyKey: "after-settlement",
      message: "Everyone",
    });
    expect(next[0]).toBe(disposition === "cancelled");
    if (disposition === "interrupted") {
      expect(next[2]).toMatchObject(answered);
    }
  });

  it.each([true, false])(
    "admits one answer across racing and stale viewers (active=%s)",
    async (active) => {
      await using fixture = await createFixture({ storage, active, preserveContent: true });
      const params = await questionAnswer(fixture);
      const invalid = await send(fixture, {
        ...params,
        replyToId: "another-session-question",
        idempotencyKey: "invalid",
      });
      expect(invalid[0]).toBe(false);
      expect((await listSessionPendingInputs(fixture.scope)).total).toBe(0);
      const requests = [
        { ...params, idempotencyKey: "racing-first" },
        { ...params, idempotencyKey: "racing-second", message: "> Which audience?\n\nEveryone" },
      ];
      const replies = await Promise.all(requests.map((request) => send(fixture, request)));
      expect(replies.filter(([ok]) => ok)).toHaveLength(1);
      expect(replies.find(([ok]) => !ok)?.[2]).toMatchObject(answered);
      const winner = requests[replies.findIndex(([ok]) => ok)]!;
      await accept(fixture, winner);
      if (!active) {
        await (await fixture.dispatchedRecorder).persistApproved();
      }
      fixture.client.connId = "another-authorized-viewer";
      for (const [index, request] of requests.entries()) {
        const stale = await send(fixture, { ...request, idempotencyKey: "stale-" + index });
        expect(stale[0]).toBe(false);
        expect(stale[2]).toMatchObject(answered);
      }
      const accepted = [
        ...(await listSessionPendingInputs(fixture.scope)).items.map((input) => input.message),
        ...fixture.readTranscript().flatMap((event) => {
          const record = asOptionalRecord(event);
          return record?.type === "message" ? [record.message] : [];
        }),
      ];
      const answers = accepted.filter((message) => {
        const record = asOptionalRecord(message);
        return (
          record?.role === "user" &&
          asOptionalRecord(record["__openclaw"])?.asyncQuestionItemId === "audience"
        );
      });
      expect(answers).toHaveLength(1);
      expect(asOptionalRecord(answers[0])?.content).toBe(winner.message);
      const { asyncQuestionItemId: _question, ...ordinary } = winner;
      await accept(fixture, {
        ...ordinary,
        idempotencyKey: "manual-correction",
        message: "Actually, use Everyone.",
      });
      const next = await questionAnswer(fixture, "next-audience");
      await accept(fixture, { ...next, idempotencyKey: "new-question" });
    },
  );
});
