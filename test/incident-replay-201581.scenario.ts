import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { it } from "vitest";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { writeRestartPlugin } from "./gateway-restart.test-support.js";
import {
  closeHttpServer,
  connectProofClient,
  listenLoopback,
  respondJson,
} from "./helpers/gateway-integration-fixtures.js";
import { createOpenAiResponsesModelConfig } from "./helpers/openai-responses-model-fixture.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const PLUGIN = "incident-feature-error";
const MESSAGE = "Choose a project first.";

it("preserves the feature operation's caller-facing error message", async () => {
  const output = process.env.OPENCLAW_INCIDENT_REPLAY_OUTPUT;
  assert(output, "Use the incident replay runner");
  await fs.mkdir(output, { recursive: true });
  const started = performance.now();
  const facts = {
    issue: 201581,
    ready: false,
    operationsStarted: 0,
    cleanup: false,
    verdict: "blocked",
    phase: "setup",
    failure: "",
    wallMs: 0,
    setupMs: 0,
    exerciseMs: 0,
    positiveControl: false,
    visibleMessage: "",
    transport: "",
    providerRequests: 0,
  };
  const server = createServer((_request, response) => {
    facts.providerRequests++;
    respondJson(
      response,
      { error: { message: "This RPC-only fixture does not use inference" } },
      400,
    );
  });
  const url = await listenLoopback(server);
  let instance: Awaited<ReturnType<typeof createOpenClawTestInstance>> | undefined;
  let client: Awaited<ReturnType<typeof connectProofClient>> | undefined;
  let exercised = 0;
  let scenarioError: Error | undefined;
  const failures: unknown[] = [];
  try {
    const config = createOpenAiResponsesModelConfig({
      baseUrl: url,
      providerId: "feature-replay",
      modelId: "feature-replay",
      reasoning: false,
      toolProfile: "full",
    });
    instance = await createOpenClawTestInstance({
      name: "incident-replay-201581",
      config,
      env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
    });
    const plugin = instance.state.path("feature-plugin");
    await writeRestartPlugin(
      plugin,
      {
        id: PLUGIN,
        name: "Incident feature error",
        version: "0.1.0",
        activation: { onStartup: true },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      'import { defineFeatureContract } from "openclaw/plugin-sdk/feature-contract";\n' +
        'import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";\n' +
        'const input = { type: "object", properties: {}, additionalProperties: false };\n' +
        'const output = { type: "string", maxLength: 200 };\n' +
        "const contract = defineFeatureContract({ pluginId: " +
        JSON.stringify(PLUGIN) +
        ', operations: { ping: { kind: "query", description: "Qualify feature dispatch", input, output }, fail: { kind: "action", description: "Return the reported operation failure", input, output } }, events: {} });\n' +
        'export default defineFeaturePlugin({ contract, name: "Incident feature error", description: "Frozen report-only operation-error replay", setup() { return { ping: () => "FEATURE_READY", fail: () => { throw new Error(' +
        JSON.stringify(MESSAGE) +
        "); } }; } });\n",
    );
    await instance.state.writeConfig({
      ...JSON.parse(await fs.readFile(instance.configPath, "utf8")),
      plugins: {
        enabled: true,
        load: { paths: [plugin] },
        allow: [PLUGIN, "openai"],
        slots: { memory: "none" },
        entries: { [PLUGIN]: { enabled: true } },
      },
    });
    await instance.startGateway();
    client = await connectProofClient(instance, {
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    facts.ready = true;
    facts.phase = "qualifying-feature-dispatch";
    const good = await client.request("plugins.sessionAction", {
      pluginId: PLUGIN,
      actionId: "ping",
      payload: {},
    });
    await fs.writeFile(
      path.join(output, "positive-client-response.json"),
      JSON.stringify(good, null, 2),
    );
    assert(
      JSON.stringify(good).includes("FEATURE_READY"),
      "Feature activation/dispatch qualification failed",
    );
    facts.positiveControl = true;
    facts.setupMs = performance.now() - started;
    facts.operationsStarted = 1;
    facts.phase = "observing-operation-error";
    exercised = performance.now();
    let observed: unknown;
    try {
      const payload = await client.request<{ ok?: boolean; error?: string | { message?: string } }>(
        "plugins.sessionAction",
        { pluginId: PLUGIN, actionId: "fail", payload: {} },
      );
      facts.transport = "response";
      observed = payload;
      facts.visibleMessage =
        typeof payload.error === "string" ? payload.error : (payload.error?.message ?? "");
      assert.equal(payload.ok, false, "INCIDENT_REPLAY: operation failure was reported as success");
    } catch (error) {
      if (error instanceof assert.AssertionError) {
        throw error;
      }
      facts.transport = "rpc-error";
      facts.visibleMessage = error instanceof Error ? error.message : String(error);
      // Keep only public error text; stacks and causes are not the caller's operation message.
      observed = { message: facts.visibleMessage };
    }
    await fs.writeFile(
      path.join(output, "failure-client-response.json"),
      JSON.stringify(observed, null, 2),
    );
    assert(
      facts.visibleMessage.includes(MESSAGE),
      "INCIDENT_REPLAY: caller lost the operation message; got " +
        JSON.stringify(facts.visibleMessage),
    );
    facts.verdict = "pass";
  } catch (error) {
    facts.failure = String(error);
    facts.verdict =
      facts.positiveControl && facts.failure.includes("INCIDENT_REPLAY:")
        ? "assertion-failed"
        : "blocked";
    scenarioError = error instanceof Error ? error : new Error(String(error), { cause: error });
  } finally {
    facts.exerciseMs = exercised ? performance.now() - exercised : 0;
    if (client) {
      try {
        await disconnectGatewayClient(client);
      } catch (error) {
        failures.push(error);
      }
    }
    if (instance) {
      try {
        await instance.cleanup();
      } catch (error) {
        failures.push(error);
      }
      await fs.writeFile(path.join(output, "gateway.log"), instance.logs());
    }
    try {
      await closeHttpServer(server);
    } catch (error) {
      failures.push(error);
    }
    facts.cleanup = failures.length === 0;
    facts.wallMs = performance.now() - started;
    await fs.writeFile(path.join(output, "observation.json"), JSON.stringify(facts, null, 2));
  }
  if (failures.length) {
    throw new AggregateError(
      scenarioError ? [scenarioError, ...failures] : failures,
      "Feature replay cleanup failed",
    );
  }
  if (scenarioError) {
    throw scenarioError;
  }
}, 180_000);
