import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { roleClient, rolePolicyConfig } from "../session-sharing.test-utils.js";
import { createHistoryReadContext } from "./chat-history.test-helpers.js";
import { chatRpc } from "./chat-rpc-fixture.test-support.js";
import { disposeSessionReadContexts } from "./sessions-read-cache.test-support.js";

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
// mock-isolation: The registered RPC, authorization and transcript readers are real; model dispatch is isolated.
vi.mock("../answer-lens-completion.js", () => ({ completeAnswerLens: complete }));
beforeEach(() => {
  complete
    .mockReset()
    .mockResolvedValue({ text: "Simpler answer.", provider: "fixture", model: "utility" });
});

async function fixture() {
  const cfg = rolePolicyConfig();
  setRuntimeConfigSnapshot(cfg);
  const client = roleClient("write", "lens-owner");
  client.connId = "lens-owner-connection";
  const scope = { agentId: "main", sessionKey: "agent:main:lens", sessionId: "lens-session" };
  await upsertSessionEntryCore(scope, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    status: "done",
    visibility: "draft",
    createdActor: {
      type: "human",
      source: "profile",
      id: expectDefined(client.authenticatedUserProfile, "profile").profileId,
    },
  });
  const answer = await appendTranscriptMessage(scope, {
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "secret reasoning" },
        { type: "text", text: "A 10 mg dose may help, but the evidence is uncertain." },
      ],
    },
  });
  const context = await createHistoryReadContext({ getRuntimeConfig: () => cfg });
  let id = 0;
  const request = (params = {}, caller = client) =>
    chatRpc(context, caller, "chat.answer.transform", {
      sessionKey: scope.sessionKey,
      messageId: answer.messageId,
      requestId: String(++id),
      coverage: "full",
      wording: "original",
      ...params,
    });
  return { scope, client, context, request };
}
async function withLens(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    try {
      await run(await fixture());
    } finally {
      await disposeSessionReadContexts();
    }
  });
}

it("resolves canonical visible prose and keeps transformations out of history", () =>
  withLens(async (f) => {
    const before = await loadTranscriptEvents(f.scope);
    const baseline = await f.request();
    expect(baseline).toMatchObject([
      true,
      { text: "A 10 mg dose may help, but the evidence is uncertain.", durationMs: 0 },
    ]);
    expect(complete).not.toHaveBeenCalled();
    const { sourceRevision } = baseline[1] as { sourceRevision: string };
    expect(await f.request({ sourceRevision, wording: "plain" })).toMatchObject([
      true,
      { text: "Simpler answer." },
    ]);
    expect(complete.mock.calls[0]?.[0].source).not.toContain("secret reasoning");
    expect(await loadTranscriptEvents(f.scope)).toEqual(before);
  }));

it("rewrites Full Technical but returns Original without inference", () =>
  withLens(async (f) => {
    const baseline = await f.request();
    const { sourceRevision } = baseline[1] as { sourceRevision: string };
    expect(complete).not.toHaveBeenCalled();
    expect(await f.request({ sourceRevision, wording: "technical" })).toMatchObject([
      true,
      { text: "Simpler answer.", wording: "technical", coverage: "full" },
    ]);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ coverage: "full", wording: "technical" });
    expect(await f.request()).toMatchObject([true, { durationMs: 0 }]);
    expect(complete).toHaveBeenCalledTimes(1);
  }));

it("refuses stale revisions, inaccessible sources and read-only operators before inference", () =>
  withLens(async (f) => {
    expect((await f.request({ sourceRevision: "0".repeat(64), wording: "plain" }))[0]).toBe(false);
    const foreign = roleClient("write", "foreign");
    foreign.connId = "foreign";
    expect((await f.request({}, foreign))[0]).toBe(false);
    const readOnly = { ...f.client, connect: { ...f.client.connect, scopes: ["operator.read"] } };
    expect((await f.request({}, readOnly))[0]).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  }));

it("discards inference after source session replacement", () =>
  withLens(async (f) => {
    const baseline = await f.request();
    const entered = createDeferred<void>();
    const gate = createDeferred<void>();
    complete.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return { text: "Should not escape", provider: "fixture", model: "utility" };
    });
    const operation = f.request({
      wording: "plain",
      sourceRevision: (baseline[1] as { sourceRevision: string }).sourceRevision,
    });
    await entered.promise;
    await patchSessionEntryCore(f.scope, () => ({ sessionId: "replacement" }));
    gate.resolve();
    expect((await operation)[0]).toBe(false);
  }));

it("cancels only the requesting connection's active operation", () =>
  withLens(async (f) => {
    const baseline = await f.request();
    const entered = createDeferred<void>();
    const gate = createDeferred<void>();
    complete.mockImplementation(async () => {
      entered.resolve();
      await gate.promise;
      return { text: "Should not escape", provider: "fixture", model: "utility" };
    });
    const operation = f.request({
      requestId: "cancel-me",
      wording: "plain",
      sourceRevision: (baseline[1] as { sourceRevision: string }).sourceRevision,
    });
    await entered.promise;
    const foreign = roleClient("write", "foreign");
    foreign.connId = "foreign";
    expect(
      await chatRpc(f.context, foreign, "chat.answer.cancel", { requestId: "cancel-me" }),
    ).toMatchObject([true, { cancelled: false }]);
    expect(
      await chatRpc(f.context, f.client, "chat.answer.cancel", { requestId: "cancel-me" }),
    ).toMatchObject([true, { cancelled: true }]);
    gate.resolve();
    expect((await operation)[0]).toBe(false);
  }));

it("rejects code before inference without changing it", () =>
  withLens(async (f) => {
    const text = "Use `const count = 1` in this example.";
    const answer = await appendTranscriptMessage(f.scope, {
      message: { role: "assistant", stopReason: "stop", content: text },
    });
    const baseline = await f.request({ messageId: answer.messageId });
    expect(baseline).toMatchObject([true, { text }]);
    expect(
      (
        await f.request({
          messageId: answer.messageId,
          wording: "plain",
          sourceRevision: (baseline[1] as { sourceRevision: string }).sourceRevision,
        })
      )[0],
    ).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  }));

it("does not disclose provider error details", () =>
  withLens(async (f) => {
    const baseline = await f.request();
    complete.mockRejectedValueOnce(new Error("provider-secret-example-token"));
    const response = await f.request({
      wording: "plain",
      sourceRevision: (baseline[1] as { sourceRevision: string }).sourceRevision,
    });
    expect(response[0]).toBe(false);
    expect(JSON.stringify(response)).not.toContain("provider-secret-example-token");
  }));

it("streams only to the requesting connection and fences chunks after cancellation", () =>
  withLens(async (f) => {
    const baseline = await f.request();
    const entered = createDeferred<void>();
    const gate = createDeferred<void>();
    const broadcast = vi.spyOn(f.context, "broadcastToConnIds");
    let onText!: (text: string) => void;
    complete.mockImplementation(async (params) => {
      onText = params.onText;
      onText("Visible first words");
      entered.resolve();
      await gate.promise;
      return { text: "Final words", provider: "fixture", model: "utility" };
    });
    const operation = f.request({
      requestId: "stream-me",
      wording: "plain",
      sourceRevision: (baseline[1] as { sourceRevision: string }).sourceRevision,
    });
    await entered.promise;
    expect(broadcast).toHaveBeenCalledWith(
      "chat.answer.delta",
      expect.objectContaining({
        requestId: "stream-me",
        text: "Visible first words",
        sessionKey: f.scope.sessionKey,
      }),
      new Set([f.client.connId]),
    );
    await chatRpc(f.context, f.client, "chat.answer.cancel", { requestId: "stream-me" });
    expect(() => onText("Late words")).toThrow();
    expect(broadcast).toHaveBeenCalledTimes(1);
    gate.resolve();
    expect((await operation)[0]).toBe(false);
  }));
