/**
 * Wire-contract integration test for the ask_user_question seam.
 *
 * Exercises the REAL path a UI/channel client takes to answer a pending question:
 *   asking tool -> QuestionManager.register (parks a promise)
 *   -> real question.resolve gateway handler (validates params, checks visibility)
 *   -> QuestionManager.resolve -> tool promise settles with answers.
 *
 * The whole point is to catch param-name drift at the client<->gateway boundary:
 * the exact `{ id, answers: { [id]: { text } } }` shape must cross, and a drifted
 * param name (e.g. `answer`) must FAIL validation rather than silently no-op.
 */
import { describe, expect, it } from "vitest";
import { QuestionManager } from "../question-manager.js";
import { createQuestionHandlers, toQuestionListEntry } from "./question.js";
import type { GatewayClient } from "./types.js";

type Captured = { ok: boolean; payload: unknown; error: unknown };

function makeRespond() {
  const calls: Captured[] = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  return { respond, calls };
}

function adminClient(): GatewayClient {
  return {
    connect: { scopes: ["operator.admin"], client: { id: "ui", displayName: "Control UI" } },
  } as unknown as GatewayClient;
}

function unscopedClient(): GatewayClient {
  return {
    connect: { scopes: ["operator.read"], client: { id: "reader" } },
  } as unknown as GatewayClient;
}

const CONTEXT = {} as never;

describe("question resolve/list wire contract", () => {
  it("resolves a parked tool promise with the exact answers shape from the client", async () => {
    const manager = new QuestionManager();
    const handlers = createQuestionHandlers(manager);

    // Asking tool parks on the promise.
    const { record, wait } = manager.register({
      sessionKey: "s1",
      turnSourceChannel: "telegram",
      questions: [
        {
          id: "q1",
          header: "Deploy",
          question: "Ship it?",
          isOther: true,
          options: [{ label: "Yes (Recommended)" }, { label: "No" }],
        },
      ],
    });

    // A client answers with the canonical wire params: { id, answers: { [id]: { text } } }.
    const { respond, calls } = makeRespond();
    await handlers["question.resolve"]!({
      params: { id: record.id, answers: { q1: { text: "Yes (Recommended)" } } },
      respond,
      client: adminClient(),
      context: CONTEXT,
    } as never);

    expect(calls.at(-1)).toEqual({ ok: true, payload: { ok: true }, error: undefined });
    await expect(wait).resolves.toEqual({ q1: { text: "Yes (Recommended)" } });
  });

  it("REJECTS a drifted answers param name so contract drift cannot ship green", async () => {
    const manager = new QuestionManager();
    const handlers = createQuestionHandlers(manager);
    const { record, wait } = manager.register({
      questions: [{ id: "q1", header: "H", question: "Q" }],
    });

    const { respond, calls } = makeRespond();
    // `answer` (singular) instead of `answers` — the exact drift the seam must catch.
    await handlers["question.resolve"]!({
      params: { id: record.id, answer: { q1: { text: "x" } } },
      respond,
      client: adminClient(),
      context: CONTEXT,
    } as never);

    const last = calls.at(-1)!;
    expect(last.ok).toBe(false);
    expect(JSON.stringify(last.error)).toContain("invalid question.resolve params");
    // The tool promise is still parked because nothing valid resolved it.
    expect(manager.getSnapshot(record.id)?.status).toBe("pending");
    void wait; // still pending
  });

  it("REJECTS an answer entry missing the text field", async () => {
    const manager = new QuestionManager();
    const handlers = createQuestionHandlers(manager);
    const { record } = manager.register({ questions: [{ id: "q1", header: "H", question: "Q" }] });
    const { respond, calls } = makeRespond();
    await handlers["question.resolve"]!({
      params: { id: record.id, answers: { q1: { value: "x" } } },
      respond,
      client: adminClient(),
      context: CONTEXT,
    } as never);
    expect(calls.at(-1)!.ok).toBe(false);
    expect(manager.getSnapshot(record.id)?.status).toBe("pending");
  });

  it("hides pending questions from clients without admin/approvals scope", async () => {
    const manager = new QuestionManager();
    const handlers = createQuestionHandlers(manager);
    const { record } = manager.register({ questions: [{ id: "q1", header: "H", question: "Q" }] });

    // list is empty for an unscoped client...
    const listCall = makeRespond();
    await handlers["question.list"]!({
      params: {},
      respond: listCall.respond,
      client: unscopedClient(),
      context: CONTEXT,
    } as never);
    expect(listCall.calls.at(-1)!.payload).toEqual({ questions: [] });

    // ...and resolve is rejected as not-found rather than leaking existence.
    const resolveCall = makeRespond();
    await handlers["question.resolve"]!({
      params: { id: record.id, answers: { q1: { text: "x" } } },
      respond: resolveCall.respond,
      client: unscopedClient(),
      context: CONTEXT,
    } as never);
    expect(resolveCall.calls.at(-1)!.ok).toBe(false);
    expect(manager.getSnapshot(record.id)?.status).toBe("pending");
  });

  it("question.list returns the exact pending entry shape an admin client renders", async () => {
    const manager = new QuestionManager();
    const handlers = createQuestionHandlers(manager);
    const { record } = manager.register({
      sessionKey: "s1",
      turnSourceChannel: "slack",
      questions: [{ id: "q1", header: "H", question: "Q", isOther: true }],
    });
    const { respond, calls } = makeRespond();
    await handlers["question.list"]!({
      params: {},
      respond,
      client: adminClient(),
      context: CONTEXT,
    } as never);
    expect(calls.at(-1)!.payload).toEqual({ questions: [toQuestionListEntry(record)] });
  });

  it("rejects resolving an unknown question id", async () => {
    const manager = new QuestionManager();
    const handlers = createQuestionHandlers(manager);
    const { respond, calls } = makeRespond();
    await handlers["question.resolve"]!({
      params: { id: "does-not-exist", answers: { q1: { text: "x" } } },
      respond,
      client: adminClient(),
      context: CONTEXT,
    } as never);
    expect(calls.at(-1)!.ok).toBe(false);
  });
});
