import { expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { estimateCompactionHistoryTokens } from "../../agents/sessions/context-token-pressure.js";
import { withSessionState } from "../../agents/sessions/session-manager-fixtures.test-support.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { toolResult } from "../../agents/sessions/session-message-fixtures.test-support.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { boundContextEngineAssembly } from "../../context-engine/bounded-context.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { readSessionContextSeed } from "./session-context-seed.js";
import { prepareSessionHistoryReadOperation } from "./session-history-read-operation.worker.js";

it("bounds full payload hydration at the native seed worker operation, not its output", async () => {
  await withSessionState("native-seed-read-boundary", async ({ scope }) => {
    const manager = SessionManager.open(scope);
    for (let index = 0; index < 16; index++) {
      manager.appendMessage(
        makeUserMessage("seed-payload-" + index + ":" + "x".repeat(16_384), index),
      );
    }
    manager.appendMessage(makeUserMessage("recent seed request", 20));
    const full = manager.buildSessionContext().messages;
    const request = { maxBytes: 4096, tokenBudget: 1024, beforeAdmittedUser: false };
    const expectedIdentity = readDatabasePathIdentitySync(scope.storePath);
    const bounded = await prepareSessionHistoryReadOperation({
      kind: "context-messages",
      target: scope,
      expectedIdentity,
      seed: request,
    });
    const unbounded = await prepareSessionHistoryReadOperation({
      kind: "context-messages",
      target: scope,
      expectedIdentity,
    });
    const measure = (run: () => unknown) => {
      const parse = JSON.parse;
      let count = 0;
      let bytes = 0;
      const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
        if (text.includes("seed-payload-")) {
          count++;
          bytes += Buffer.byteLength(text);
        }
        return parse(text, reviver);
      });
      try {
        const result = run();
        return { result, count, bytes };
      } finally {
        spy.mockRestore();
      }
    };
    const baseline = measure(unbounded);
    const candidate = measure(bounded);
    expect(baseline.count).toBe(16);
    expect(candidate.count).toBe(1); // Only the first overflowing row, not all omitted bodies.
    expect(candidate.bytes).toBeLessThan(baseline.bytes / 8);
    expect(candidate.result).toMatchObject({
      messages: boundContextEngineAssembly({ messages: full, estimatedTokens: 0 }, 4096, 1024)
        .messages,
      seed: { omittedCount: 16, omittedNonSummary: true, retainedInputTokens: 0 },
    });
    expect(baseline.result).toMatchObject({ messages: full });
  });
});

it("preserves full-fidelity seed selection, tool pairs, summary and admitted-tail accounting", async () => {
  await withSessionState("native-seed-selection", async ({ scope }) => {
    const manager = SessionManager.open(scope);
    const first = manager.appendMessage(makeUserMessage("old request " + "x".repeat(8192), 1));
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [
          { type: "toolCall", id: "read", name: "read", arguments: { path: "synthetic.txt" } },
        ],
      }),
    );
    manager.appendMessage(makeUserMessage("interleaved request", 2));
    manager.appendMessage({
      ...toolResult("full result", "read", 3),
      details: { evidence: "retained detail" },
    });
    manager.appendCompaction("preserve this summary", first, 100);
    const branch = manager.branchWithSummary(manager.getLeafId(), "preserve this branch summary");
    manager.branchWithSummary(branch, "");
    manager.appendMessage(makeUserMessage("recent request", 4));
    const admitted: PersistedUserTurnMessage = {
      ...makeUserMessage("admitted request", 5),
      idempotencyKey: "current:user",
    };
    manager.appendMessage(admitted);
    manager.appendMessage(
      makeAgentAssistantMessage({ content: [{ type: "text", text: "current answer" }] }),
    );
    const full = manager.buildSessionContext().messages;
    const current = full.findIndex(
      (message) =>
        message.role === "user" && Reflect.get(message, "idempotencyKey") === "current:user",
    );
    expect(current).toBeGreaterThan(0);
    for (const beforeAdmittedUser of [false, true]) {
      for (const maxBytes of [512, 4096, 32768]) {
        const seed = {
          maxBytes,
          tokenBudget: 8192,
          admittedKey: "current:user",
          beforeAdmittedUser,
        };
        const run = await prepareSessionHistoryReadOperation({
          kind: "context-messages",
          target: scope,
          expectedIdentity: readDatabasePathIdentitySync(scope.storePath),
          seed,
        });
        const result = run();
        const history = beforeAdmittedUser
          ? full.slice(0, current)
          : full.filter((_, index) => index !== current);
        const expected = boundContextEngineAssembly(
          { messages: history, estimatedTokens: 0 },
          maxBytes,
          8192,
        ).messages;
        expect(result.messages).toEqual(expected);
        expect(result.seed).toMatchObject({
          omittedCount: history.length - expected.length,
          retainedInputTokens: estimateCompactionHistoryTokens(full.slice(current)),
          summary: history.findLast((message) => message.role === "compactionSummary"),
        });
        expect(result.seed?.admittedUser).toEqual(beforeAdmittedUser ? full[current] : undefined);
        // Resident memory shares the exact same projection/selection owner.
        expect(readSessionContextSeed(manager.getBranch(), seed)).toEqual({
          messages: result.messages,
          seed: result.seed,
        });
      }
    }
  });
});
