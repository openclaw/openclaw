import type { DecisionRuntimeV2 } from "openclaw/plugin-sdk/decisions";
import { afterEach, expect, it, vi } from "vitest";
import { memoryFixture, useTestTempDirs } from "../extensions/knowledge/test-api.js";
import { resetDecisionTestRuntime } from "../src/agents/decision-inference.test-support.js";
import { withRerank } from "../src/decisions/rerank.test-support.js";
import { evaluateDecisionV2InRegistry } from "../src/decisions/runtime.js";

// The Knowledge recall hook's own grant, carried through the real Decision
// runtime and bundled rerank provider to a recorded /rerank server.
const tempDirs = useTestTempDirs();
afterEach(() => resetDecisionTestRuntime());

type Stage = "allowed" | "ungranted" | "before-dispatch" | "before-retry" | "before-publish";

async function recall(stage: Stage) {
  let f!: Awaited<ReturnType<typeof memoryFixture>>;
  let outcome: { result: unknown; sent: number; bodies: unknown[]; logged: unknown[] };
  await withRerank(
    stage === "before-retry" ? "texts" : "documents",
    undefined,
    () => {
      if (stage === "before-retry") {
        f.revoke();
      }
    },
    async ({ config, registry, requests }) => {
      f = await memoryFixture(tempDirs, {}, { recallGate: { mode: "live" } });
      const info = vi.fn();
      (f.api as { logger?: unknown }).logger = { info };
      const evaluateV2: DecisionRuntimeV2["evaluateV2"] = async (batch, options) => {
        if (stage === "before-dispatch") {
          f.revoke();
        }
        const result = await evaluateDecisionV2InRegistry(
          batch,
          options,
          registry,
          config,
          "knowledge",
        );
        if (stage === "before-publish") {
          f.revoke();
        }
        return result;
      };
      (f.api.runtime as { decisions?: unknown }).decisions = { evaluate: vi.fn(), evaluateV2 };
      await f.save("Nova vaccination schedule", "Nova's rabies booster is due in March.");
      await f.save("Garage door opener", "Remote codes.");
      const gateHook = f.hookList.before_prompt_build!.at(-1);
      const result = await gateHook(
        { prompt: "Is Nova due for her shots?", messages: [] },
        {
          agentId: "main",
          trigger: "user",
          sessionKey: f.context.authority.sessionKey,
          sessionId: f.sessionId,
          sandboxed: false,
          memoryAudience: stage === "ungranted" ? f.conversation : f.context.authority.audience,
          assertMemoryAudienceCurrent: f.context.assertCurrent,
        },
      );
      outcome = {
        result,
        sent: requests.length,
        bodies: requests.map((r) => r.body),
        logged: info.mock.calls.map((c) => JSON.parse(String(c[0]).replace(/^[^{]*/u, ""))),
      };
    },
  );
  return outcome!;
}

it("an owner-private turn sends only the matched excerpt and injects it", async () => {
  const { result, sent, bodies, logged } = await recall("allowed");
  expect(sent).toBe(1);
  expect(bodies[0]).toEqual({
    model: "bge-reranker-v2-m3",
    query: "Is Nova due for her shots?",
    documents: ["Nova vaccination schedule\nNova's rabies booster is due in March."],
  });
  expect(result).toEqual({ prependContext: expect.stringContaining("rabies booster") });
  expect(logged[0]).toMatchObject({ mode: "live", outcome: "injected" });
});

it.each([
  ["an ungranted conversation audience", "ungranted", 0],
  ["a grant revoked before dispatch", "before-dispatch", 0],
  ["a grant revoked before the TEI retry", "before-retry", 1],
  ["a grant revoked after scoring, before publication", "before-publish", 1],
] as const)("%s publishes nothing", async (_label, stage, sent) => {
  const outcome = await recall(stage);
  expect(outcome.sent).toBe(sent);
  expect(outcome.result).toBe(undefined);
  expect(JSON.stringify(outcome.bodies)).not.toContain("Garage");
});
