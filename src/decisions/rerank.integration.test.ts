import { afterEach, expect, it } from "vitest";
import {
  resetDecisionTestRuntime,
  decisionOptions,
} from "../agents/decision-inference.test-support.js";
import { refreshPreparedModelRuntimeCatalog } from "../agents/prepared-model-runtime.js";
import { listDecisionModels } from "../gateway/server-methods/models-list-capabilities.js";
import { withRerank } from "./rerank.test-support.js";
import { evaluateDecisionV2InRegistry } from "./runtime.js";
import type { DecisionBatchV2 } from "./types-v2.js";

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "How do I reset the router?" },
  questions: {
    page: { type: "boolean", instructions: "Router reset steps" },
    topic: { type: "choice", criteria: { network: "Networking help", billing: null } },
  },
};

afterEach(() => resetDecisionTestRuntime());

it.each([
  ["a keyless Cohere-style", undefined, "documents"],
  ["a keyed Cohere-style", "synthetic-rerank-key", "documents"],
  ["a TEI-style", undefined, "texts"],
] as const)(
  "answers Boolean and Choice questions through %s /rerank server",
  async (_label, apiKey, field) =>
    withRerank(
      field,
      apiKey,
      () => {},
      async ({ config, registry, run, requests }) => {
        const outcome = await evaluateDecisionV2InRegistry(
          batch,
          decisionOptions({ agentId: "main" }),
          registry,
          config,
        );
        expect(outcome).toMatchObject({
          status: "ok",
          result: {
            model: "bge-reranker-v2-m3",
            answers: {
              page: { type: "boolean", probabilityTrue: 0.91 },
              topic: {
                type: "choice",
                choice: "network",
                probabilities: { network: 0.62, billing: 0.08 },
              },
            },
          },
          provenance: { providerId: "rerank" },
        });
        // The live catalog the Decision picker reads lists the configured row.
        const catalog = await refreshPreparedModelRuntimeCatalog(run.snapshot);
        expect(
          listDecisionModels({
            config,
            snapshot: run.snapshot.metadataSnapshot,
            catalog: catalog!.entries,
          }),
        ).toContainEqual(
          expect.objectContaining({
            provider: "rerank",
            id: "bge-reranker-v2-m3",
            pluginId: "rerank",
          }),
        );
        expect(requests.at(-1)).toEqual({
          path: "/v1/rerank",
          auth: apiKey ? `Bearer ${apiKey}` : undefined,
          body: {
            model: "bge-reranker-v2-m3",
            query: "How do I reset the router?",
            [field]: ["Router reset steps", "Networking help", "billing"],
          },
        });
        // TEI rejects the Cohere field once, then the endpoint is remembered.
        expect(requests).toHaveLength(field === "texts" ? 2 : 1);
      },
    ),
);

// A caller grant revoked mid-request must stop egress, not only publication.
it.each([
  ["during preparation", 2, 0],
  ["between the first request and its retry", Infinity, 1],
] as const)(
  "sends nothing more once caller authority is revoked %s",
  async (_label, okCalls, sent) => {
    let revoked = false;
    let calls = 0;
    const assertCurrent = () => {
      calls += 1;
      if (revoked || calls > okCalls) {
        revoked = true;
        throw new Error("Knowledge grant revoked");
      }
    };
    await withRerank(
      "texts",
      undefined,
      () => {
        revoked = true;
      },
      async ({ config, registry, requests }) => {
        await expect(
          evaluateDecisionV2InRegistry(
            batch,
            { ...decisionOptions({ agentId: "main" }), assertCurrent },
            registry,
            config,
          ),
        ).rejects.toThrow("Knowledge grant revoked");
        expect(requests).toHaveLength(sent);
      },
    );
  },
);
