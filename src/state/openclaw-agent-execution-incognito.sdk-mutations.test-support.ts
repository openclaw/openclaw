import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { withSessionTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import { withCodexSessionTranscriptMirrorWrite } from "../plugin-sdk/codex-session-transcript-runtime.js";
import {
  appendAssistantMirrorMessageByIdentity,
  resolveSessionTranscriptIdentity,
  withSessionTranscriptWrite,
  type SessionTranscriptWriteContext,
} from "../plugin-sdk/session-transcript-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import type { IncognitoMutationFixture } from "./openclaw-agent-execution-incognito.mutation-admission.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";

export function registerIncognitoSdkMutationTests(
  getFixture: () => IncognitoMutationFixture,
): void {
  it("resolves an unqualified SDK transcript key through its bound actor", async () => {
    const { actor, authority, key, entry, env } = getFixture();
    const sessionId = "sdk-unqualified-target";
    const sessionKey = key(sessionId);
    await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
    const sql = observeMainThreadSql();
    try {
      await expect(
        withIncognitoSessionActor(actor, () =>
          resolveSessionTranscriptIdentity({
            agentId: actor.agentId,
            storePath: actor.path,
            env,
            sessionId,
            sessionKey: "dashboard:incognito-sdk-unqualified-target",
          }),
        ),
      ).resolves.toMatchObject({ agentId: actor.agentId, sessionId, sessionKey });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
  });

  it("prepares SDK sequence appends outside transactions and refuses a changed read snapshot", async () => {
    const { actor, authority, key, entry, env } = getFixture();
    const sessionKey = key("sdk-sequence");
    await actor.sessions.create(authority, { sessionKey, entry: entry("sdk-sequence") });
    const foreign = { sessionKey: key("sdk-sequence-foreign"), sessionId: "sdk-sequence-foreign" };
    const foreignKey = "sdk-sequence-foreign-key";
    await actor.sessions.create(authority, {
      sessionKey: foreign.sessionKey,
      entry: entry(foreign.sessionId),
    });
    await actor.sessions.transcript(authority, {
      type: "session.message.append",
      input: {
        ...foreign,
        fence: {},
        message: {
          role: "assistant",
          content: "foreign transcript must stay private",
          idempotencyKey: foreignKey,
        },
      },
    });
    const target = {
      agentId: "main",
      storePath: actor.path,
      sessionKey,
      sessionId: "sdk-sequence",
      env,
    };
    const prepare = vi.fn(
      async (message: { role: string; content: string; idempotencyKey: string }) => ({
        ...message,
        content: "prepared",
      }),
    );
    const original = { role: "assistant", content: "original", idempotencyKey: "sdk-sequence-one" };
    const external = new AsyncResource("incognito-sequence-callback");
    const guard = vi.fn(() => {});
    const writerGuard = Object.assign(guard, {
      async prepareSessionSource() {
        return { assertCurrent: guard, checks: [] };
      },
    });
    const sql = observeMainThreadSql();
    try {
      await withIncognitoSessionActor(actor, async () => {
        await withSessionTranscriptWriteAssertion(target, writerGuard, () =>
          withSessionTranscriptWrite(target, async (write) => {
            writerGuard.mockClear();
            await expect(
              external.runInAsyncScope(() =>
                write.appendMessage({
                  eventId: "sdk-sequence-one",
                  message: original,
                  preparation: { prepareMessage: prepare },
                }),
              ),
            ).resolves.toMatchObject({ appended: true, message: { content: "prepared" } });
            expect(writerGuard).toHaveBeenCalled();
            await expect(
              write.appendMessage({ message: original, preparation: { prepareMessage: prepare } }),
            ).resolves.toMatchObject({ appended: false, message: { content: "prepared" } });
            await expect(
              write.appendMessage({
                message: { role: "assistant", content: "suppressed" },
                preparation: { prepareMessage: async () => undefined },
              }),
            ).resolves.toBeUndefined();
          }),
        );
        expect(prepare).toHaveBeenCalledTimes(1);
        const query = {
          ...foreign,
          idempotencyKeys: [original.idempotencyKey, foreignKey],
          fence: {},
          ownerSources: [],
        };
        const facts = await withCodexSessionTranscriptMirrorWrite(target, (write) =>
          write.readMessageFacts(query),
        );
        expect(facts.existingIdempotencyKeys).toEqual(new Set([original.idempotencyKey]));
        expect(facts.messagesByIdempotencyKey.get(original.idempotencyKey)).toMatchObject({
          content: "prepared",
        });
        expect(facts.messagesByIdempotencyKey.has(foreignKey)).toBe(false);
        await withSessionTranscriptWrite(target, async (write) => {
          expect(await write.readEvents()).toEqual(
            expect.arrayContaining([expect.objectContaining({ id: "sdk-sequence-one" })]),
          );
          await actor.sessions.transcript(authority, {
            type: "session.message.append",
            input: {
              sessionKey,
              sessionId: target.sessionId,
              fence: {},
              message: { role: "assistant", content: "concurrent" },
            },
          });
          await expect(
            write.appendMessage({ message: { role: "assistant", content: "stale decision" } }),
          ).rejects.toThrow(/changed|conflict/i);
        });
        await expect(
          appendAssistantMirrorMessageByIdentity({
            ...target,
            text: "mirror",
            idempotencyKey: "sdk-sequence-mirror",
            updateMode: "none",
          }),
        ).resolves.toMatchObject({ ok: true });
        const events = await withSessionTranscriptWrite(target, (write) => write.readEvents());
        expect(events.filter((event) => JSON.stringify(event).includes("stale decision"))).toEqual(
          [],
        );
        sql.expectIdle();
      });
    } finally {
      external.emitDestroy();
      sql.restore();
    }
  });

  it.each(["model_change", "custom"] as const)(
    "correlates actor channel-final mirrors past trailing %s events",
    async (kind) => {
      const { actor, authority, key, entry, env } = getFixture();
      const sessionId = `mirror-metadata-${kind}`;
      const sessionKey = key(sessionId);
      const sourceId = `${sessionId}-source`;
      await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
      const target = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId, env };
      const sql = observeMainThreadSql();
      try {
        await withIncognitoSessionActor(actor, async () => {
          await withSessionTranscriptWrite(target, (write) =>
            write.appendMessage({
              eventId: sourceId,
              message: { role: "assistant", content: [{ type: "text", text: "mirror me" }] },
            }),
          );
          await actor.sessions.transcript(authority, {
            type: "session.event.append",
            input: {
              sessionKey,
              sessionId,
              fence: {},
              eventJson: JSON.stringify({
                id: `${sessionId}-metadata`,
                parentId: sourceId,
                timestamp: "2026-10-08T00:00:00.000Z",
                ...(kind === "model_change"
                  ? { type: kind, provider: "openclaw", modelId: "synthetic" }
                  : { type: kind, customType: "proof", data: { note: "trailing metadata" } }),
              }),
            },
          });
          await expect(
            appendAssistantMirrorMessageByIdentity({
              ...target,
              text: "mirror me",
              idempotencyKey: "mirror-copy",
              deliveryMirror: { kind: "channel-final" },
              updateMode: "none",
            }),
          ).resolves.toMatchObject({ ok: true });
          const facts = await withCodexSessionTranscriptMirrorWrite(target, (write) =>
            write.readMessageFacts({ idempotencyKeys: ["mirror-copy"] }),
          );
          expect(
            facts.messagesByIdempotencyKey.get("mirror-copy"),
            `Channel-final mirror lost correlation after ${kind}`,
          ).toMatchObject({
            openclawDeliveryMirror: {
              kind: "channel-final",
              sourceAssistantMessageId: sourceId,
            },
          });
          sql.expectIdle();
        });
      } finally {
        sql.restore();
      }
    },
  );

  it("cancels a new SDK append during async message preparation without persisting", async () => {
    const { actor, authority, key, entry, env } = getFixture();
    const sessionId = "sdk-preparation-cancelled";
    const sessionKey = key(sessionId);
    await actor.sessions.create(authority, { sessionKey, entry: entry(sessionId) });
    const target = { agentId: actor.agentId, storePath: actor.path, sessionKey, sessionId, env };
    const original = await withIncognitoSessionActor(actor, () =>
      withSessionTranscriptWrite(target, (write) => write.readEvents()),
    );
    const admission = new AbortController();
    const reason = new Error("SDK append preparation cancelled");
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const prepare = vi.fn(async (message: { role: string; content: string }) => {
      entered.resolve();
      await resume.promise;
      return message;
    });
    const writing = withIncognitoSessionActor(
      actor,
      () =>
        withSessionTranscriptWrite(target, (write) =>
          write.appendMessage({
            eventId: "cancelled-sdk-append",
            message: { role: "assistant", content: "must not persist after preparation" },
            preparation: { prepareMessage: prepare },
          }),
        ),
      admission.signal,
    );
    const outcome = writing.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        outcome,
        "SDK append preparation was not entered",
      );
      admission.abort(reason);
      resume.resolve();
      await expect(writing).rejects.toBe(reason);
      expect(prepare).toHaveBeenCalledTimes(1);
      const events = await withIncognitoSessionActor(actor, () =>
        withSessionTranscriptWrite(target, (write) => write.readEvents()),
      );
      expect(events).toEqual(original);
    } finally {
      resume.resolve();
      await Promise.allSettled([writing]);
    }
  });

  it("joins accepted SDK sequence work after its callback fails and closes retained methods", async () => {
    const { actor, authority, key, entry, env } = getFixture();
    const sessionKey = key("sdk-sequence-settlement");
    await actor.sessions.create(authority, { sessionKey, entry: entry("sdk-sequence-settlement") });
    const target = {
      agentId: "main",
      storePath: actor.path,
      sessionKey,
      sessionId: "sdk-sequence-settlement",
      env,
    };
    const borrower = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: actor.agentId,
      env,
      authority,
      existingOnly: true,
    });
    assert(borrower);
    expect(borrower.identity).toEqual(actor.identity);
    let releasing: Promise<void> | undefined;
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const failure = new Error("callback failed");
    let retained: SessionTranscriptWriteContext | undefined;
    const accepted: Promise<unknown>[] = [];
    const writing = withIncognitoSessionBinding({ actor: borrower }, () =>
      withSessionTranscriptWrite(target, (write) => {
        retained = write;
        accepted.push(
          write.appendMessage({
            eventId: "sdk-settled-one",
            message: { role: "assistant", content: "first" },
            preparation: {
              prepareMessage: async (message) => {
                entered.resolve();
                await release.promise;
                return message;
              },
            },
          }),
        );
        accepted.push(
          write.appendMessage({
            eventId: "sdk-settled-two",
            message: { role: "assistant", content: "second" },
          }),
        );
        throw failure;
      }),
    );
    const outcome = writing.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(entered.promise, outcome, "Preparation was not entered");
      releasing = borrower.release();
      assert(retained);
      await expect(retained.readEvents()).rejects.toThrow("closed");
      release.resolve();
      expect(await outcome).toBe(failure);
      await expect(Promise.all(accepted)).resolves.toMatchObject([
        { messageId: "sdk-settled-one" },
        { messageId: "sdk-settled-two" },
      ]);
      await releasing;
      const events = await withIncognitoSessionActor(actor, () =>
        withSessionTranscriptWrite(target, (write) => write.readEvents()),
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "sdk-settled-one" }),
          expect.objectContaining({ id: "sdk-settled-two" }),
        ]),
      );
    } finally {
      release.resolve();
      await Promise.allSettled([writing, ...accepted, borrower.release()]);
    }
  });
}
