import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as harness from "../decision-inference.test-support.js";
import { createDecisionTool } from "./decision-tool.js";

afterEach(() => harness.resetDecisionTestRuntime());

it.each(["native", "manifest"] as const)(
  "evaluates Liquid through the actual ClawRouter decision tool and %s HTTP offer",
  async (routeKind) => {
    const state = await createOpenClawTestState({ applyEnv: false });
    onTestFinished(async () => {
      await harness.resetDecisionTestRuntime();
      await state.cleanup();
    });
    fs.mkdirSync(path.join(state.root, "bundled"));
    const modelId = "liquid-ai/d1-ultra";
    const route =
      routeKind === "native"
        ? "/v1/native/liquid-ai/decisions/v1/systemone"
        : "/v1/proxy/liquid-ai/evaluate";
    const facts = {
      chat: false,
      decision: {
        protocol: "liquid-ai-systemone",
        questions: { boolean: { probabilities: "boolean", abstention: false } },
        billing: { unit: "tokens", source: "provider-catalog", usdPerMillion: { output: 0 } },
      },
    };
    const catalog = {
      version: "clawrouter.client-catalog.v1",
      providers: [
        {
          id: "liquid-ai",
          allowed: true,
          executable: true,
          nativeBaseUrl: "/v1/native/liquid-ai",
          routes: [
            {
              endpoint: "evaluate",
              path: "/decisions/v1/systemone",
              methods: ["POST"],
              requestFormat: "liquid.systemone",
              responseFormat: "liquid.systemone",
            },
          ],
          models: [
            {
              id: modelId,
              upstream: "d1-ultra",
              capabilities: ["llm.decisions"],
              nativeCapabilities: {
                version: "clawrouter.native-capabilities.v1",
                endpoints: {
                  evaluate: { input: ["text", "json"], inference: facts },
                },
              },
            },
          ],
          offers: [
            {
              endpoint: "evaluate",
              modelId,
              eligible: true,
              transport: "http",
              affordability: "request-dependent",
              routeKind,
              route,
            },
          ],
        },
      ],
    };
    const seen: Array<{ path?: string; authorization?: string; body: unknown }> = [];
    const reply = {
      model: "d1-ultra",
      answers: { urgent: { type: "noul", noul: 0.37 } },
      usage: { input_tokens: 14, output_tokens: 0 },
    };
    await withServer(
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          seen.push({
            path: request.url,
            authorization: request.headers.authorization,
            body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(request.url === "/v1/catalog" ? catalog : reply));
        });
      },
      async (origin) => {
        const cfg = harness.decisionConfig(state.root, `clawrouter/${modelId}`, {
          load: {
            paths: [fileURLToPath(new URL("../../../extensions/clawrouter", import.meta.url))],
          },
          entries: { clawrouter: { enabled: true } },
        });
        cfg.models = {
          providers: {
            clawrouter: {
              baseUrl: origin + "/v1",
              apiKey: "synthetic-router-key",
              models: [],
              request: { allowPrivateNetwork: true },
            },
          },
        };
        await withEnvAsync(
          harness.decisionEnv(state.root, {
            ...state.envVars,
            LIQUIDAI_API_KEY: "synthetic-never-upstream",
            HTTP_PROXY: undefined,
            HTTPS_PROXY: undefined,
            ALL_PROXY: undefined,
            http_proxy: undefined,
            https_proxy: undefined,
            all_proxy: undefined,
          }),
          async () => {
            const registry = await harness.activateDecisionRegistry(cfg, {
              pluginSdkResolution: "src",
              preferBuiltPluginArtifacts: false,
              cache: false,
            });
            expect(
              registry.decisionProviders.some((entry) => entry.host.provider.id === "clawrouter"),
            ).toBe(true);
            await using prepared = await harness.prepareDecisionRuntime(cfg, "clawrouter", modelId);
            const selected = prepared.snapshot.modelCatalog.entries.find(
              (entry) => entry.provider === "clawrouter" && entry.id === modelId,
            );
            expect(selected?.inference).toEqual({
              ...facts,
              decision: { ...facts.decision, input: ["text"] },
            });
            for (const field of ["api", "contextWindow", "maxTokens", "cost"]) {
              expect(Reflect.get(selected!, field)).toBeUndefined();
            }
            const tool = createDecisionTool("main", {
              config: cfg,
              preparedModelRuntime: prepared.snapshot,
            });
            expect(tool?.name).toBe("decision_evaluate");
            const input = {
              contractVersion: 2,
              state: { type: "text", text: "Synthetic ticket" },
              questions: { urgent: { type: "boolean", instructions: "Is this urgent?" } },
            };
            const evaluate = () => tool!.execute("liquid-fixture", input);
            expect((await evaluate()).details).toMatchObject({
              status: "ok",
              provenance: { providerId: "clawrouter" },
              result: {
                model: "d1-ultra",
                answers: { urgent: { probabilityTrue: 0.37 } },
                usage: { inputTokens: 14, outputTokens: 0 },
              },
            });
            const submitted = seen.filter((request) => request.path === route);
            expect(submitted).toHaveLength(1);
            const wire = {
              model: "d1-ultra",
              state: "Synthetic ticket",
              questions: { urgent: { type: "noul", instructions: "Is this urgent?" } },
            };
            expect(submitted[0]?.body).toEqual(routeKind === "manifest" ? { body: wire } : wire);
            expect(
              seen.every((request) => request.authorization === "Bearer synthetic-router-key"),
            ).toBe(true);
            expect(JSON.stringify(seen)).not.toContain("synthetic-never-upstream");
            // Refresh the same selected credential's grant on every execution. A cached
            // model row is neither a transport grant nor authority to use another key.
            catalog.providers[0]!.offers[0]!.eligible = false;
            expect((await evaluate()).details).toMatchObject({
              status: "unavailable",
              reason: "unsupported-input",
            });
            catalog.providers[0]!.offers[0]!.eligible = true;
            catalog.providers[0]!.routes[0]!.responseFormat = "unknown.decisions";
            expect((await evaluate()).details).toMatchObject({
              status: "unavailable",
              reason: "unsupported-input",
            });
            catalog.providers[0]!.routes[0]!.responseFormat = "liquid.systemone";
            facts.decision.protocol = "typesafe-systemone";
            expect((await evaluate()).details).toMatchObject({
              status: "unavailable",
              reason: "unsupported-input",
            });
            facts.decision.protocol = "liquid-ai-systemone";
            facts.decision.billing.source = "configured";
            expect((await evaluate()).details).toMatchObject({
              status: "unavailable",
              reason: "unsupported-input",
            });
            facts.decision.billing.source = "provider-catalog";
            expect(seen.filter((request) => request.path === route)).toHaveLength(1);
            reply.usage.output_tokens = 1;
            expect((await evaluate()).details).toMatchObject({
              status: "unavailable",
              reason: "invalid-response",
            });
            expect(seen.filter((request) => request.path === route)).toHaveLength(2);
            const controller = new AbortController();
            controller.abort(new Error("synthetic-cancel"));
            await expect(tool!.execute("cancelled", input, controller.signal)).rejects.toThrow(
              "synthetic-cancel",
            );
            expect(seen.filter((request) => request.path === route)).toHaveLength(2);
          },
        );
      },
    );
  },
);
