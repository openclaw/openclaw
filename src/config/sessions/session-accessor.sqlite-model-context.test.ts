import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import { readSessionTranscriptModelContext } from "./session-accessor.sqlite-model-context.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";

it("retains accepted background artifacts across bounded placement and compaction without rewriting legacy history", () =>
  withOpenClawTestState({ label: "background-result-placement" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "placement",
      sessionKey: "agent:main:placement",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(scope);
    const legacy = makeAgentAssistantMessage({
      provider: "openclaw",
      model: "automation-result",
      content: [{ type: "text", text: "Legacy result" }],
    });
    await manager.appendMessageAsync(legacy);
    const pending = {
      ...legacy,
      content: [{ type: "text" as const, text: "Deferred result" }],
      excludeFromContext: true,
      openclawModelPlacement: "pending",
    };
    const resultId = await manager.appendMessageAsync(pending);
    assert(resultId);
    const signed = makeAgentAssistantMessage({
      content: [{ type: "text", text: "Provider output" }],
    });
    const afterEntryId = await manager.appendMessageAsync(signed);
    assert(afterEntryId);
    for (const round of [0, 1]) {
      for (const limits of [undefined, { maxBytes: 16384, maxEvents: 1 }]) {
        const recovered = await SessionManager.openModelContextAsync(scope, { limits });
        const artifact = recovered.getEntry(resultId);
        assert(artifact?.type === "message");
        expect(artifact.message).toEqual(pending);
        expect(recovered.buildSessionContext().messages).toEqual(
          limits ? [signed] : [legacy, signed],
        );
      }
      if (round === 0) {
        // An ordinary append refreshes the warm navigation cache before recovery places the result.
        await manager.appendCustomEntryAsync("recovery-checkpoint", {});
      }
    }
    const before = JSON.stringify(loadTranscriptEventsSync(scope));
    const bounded = await SessionManager.openBoundedAsync(scope, { maxBytes: 16384, maxEvents: 2 });
    expect(bounded.getBranch().some((entry) => entry.id === resultId)).toBe(true);
    expect(bounded.buildSessionContext().messages).toEqual([signed]);
    expect((await SessionManager.openAsync(scope)).buildSessionContext().messages).toEqual([
      legacy,
      signed,
    ]);
    expect(JSON.stringify(loadTranscriptEventsSync(scope))).toBe(before);
    const marker = await manager.appendCustomEntryAsync(BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE, {
      afterEntryId,
      resultEntryIds: [resultId],
    });
    const next = { role: "user" as const, content: "Continue", timestamp: 1 };
    await manager.appendMessageAsync(next);
    const placed = { ...legacy, content: pending.content };
    for (const read of [
      () => SessionManager.openAsync(scope),
      () => SessionManager.openModelContextAsync(scope),
      () =>
        SessionManager.openModelContextAsync(scope, {
          limits: { maxBytes: 16384, maxEvents: 100 },
        }),
    ]) {
      expect((await read()).buildSessionContext().messages).toEqual([legacy, signed, placed, next]);
    }
    expect(
      (
        await SessionManager.openBoundedAsync(scope, { maxBytes: 16384, maxEvents: 2 })
      ).buildSessionContext().messages,
    ).toEqual([placed, next]);
    expect(
      (
        await SessionManager.openModelContextAsync(scope, {
          limits: { maxBytes: 16384, maxEvents: 2 },
        })
      ).buildSessionContext().messages,
    ).toEqual([placed, next]);
    // Reuse the navigation cache after the source's physical row left its retained suffix.
    expect(
      (
        await SessionManager.openModelContextAsync(scope, {
          limits: { maxBytes: 16384, maxEvents: 2 },
        })
      ).buildSessionContext().messages,
    ).toEqual([placed, next]);
    await manager.appendCompactionAsync("Earlier conversation", marker, 100);
    const compacted = (await SessionManager.openModelContextAsync(scope)).buildSessionContext()
      .messages;
    expect(compacted.slice(1)).toEqual([placed, next]);
    expect(
      JSON.stringify(loadTranscriptEventsSync(scope).slice(0, JSON.parse(before).length)),
    ).toBe(before);
  }));

it("reuses freshly decoded model payloads while keeping stored and subsequent contexts detached", () =>
  withOpenClawTestState({ label: "model-context-payload-ownership" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "payload-ownership",
      sessionKey: "agent:main:payload-ownership",
      storePath: state.statePath("transcript.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(scope);
    const retainedId = await manager.appendMessageAsync({
      role: "user",
      content: "retained question",
      timestamp: 1,
    });
    assert(retainedId);
    const compactionId = await manager.appendCompactionAsync("earlier context", retainedId, 100);
    const latestId = await manager.appendMessageAsync({
      role: "user",
      content: "latest question",
      timestamp: 2,
    });
    const stored = JSON.stringify(loadTranscriptEventsSync(scope));
    const parse = vi.spyOn(JSON, "parse");
    let context: ReturnType<typeof readSessionTranscriptModelContext>;
    let decoded: unknown[];
    try {
      context = readSessionTranscriptModelContext(scope, undefined, {
        maxBytes: 8192,
        maxEvents: 2,
      });
      decoded = parse.mock.results.map((result) => result.value);
    } finally {
      parse.mockRestore();
    }
    expect(context.events.slice(1)).toMatchObject([
      {
        type: "compaction",
        id: compactionId,
        parentId: null,
        firstKeptEntryId: compactionId,
        summary: "earlier context",
      },
      {
        type: "message",
        id: latestId,
        parentId: compactionId,
        message: { role: "user", content: "latest question", timestamp: 2 },
      },
    ]);
    const serialized = JSON.stringify(context);
    const message = context.events.at(-1);
    assert(message && typeof message === "object" && "message" in message);
    assert(message.message && typeof message.message === "object");
    Object.assign(message.message, { content: "caller mutation" });
    expect(
      JSON.stringify(
        readSessionTranscriptModelContext(scope, undefined, { maxBytes: 8192, maxEvents: 2 }),
      ),
    ).toBe(serialized);
    expect(JSON.stringify(loadTranscriptEventsSync(scope))).toBe(stored);
    for (const event of context.events) {
      expect(decoded).toContain(event);
    }
  }));
