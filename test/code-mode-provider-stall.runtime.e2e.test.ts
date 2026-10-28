import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it } from "vitest";
import { startGatewayWithClient } from "../src/gateway/test-helpers.e2e.js";
import { createTrackedProvider } from "../src/gateway/test-helpers.tracked-provider.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const createFixture = useRuntimeProofFixture(afterEach);
const TOKEN = "code-mode-stall-proof-token";
const MARKER = "CODE_MODE_STALL_RECOVERED_42";
type InputItem = { type?: string; call_id?: string; output?: string; name?: string };
type ProviderRequest = { input?: InputItem[]; stream?: boolean };

function sendExec(response: Parameters<typeof writeOpenAiResponsesSse>[0], corrected: boolean) {
  const item = {
    type: "function_call",
    id: corrected ? "fc_corrected" : "fc_invalid",
    call_id: corrected ? "call_corrected" : "call_invalid",
    name: "exec",
    arguments: JSON.stringify({
      title: corrected ? "Return the corrected result" : "Reject invalid code before dispatch",
      code: corrected ? "return 42;" : "const broken = @;",
    }),
    status: "completed",
  };
  const position = { item_id: item.id, output_index: 0 };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, arguments: "", status: "in_progress" },
    },
    { type: "response.function_call_arguments.delta", ...position, delta: item.arguments },
    { type: "response.function_call_arguments.done", ...position, arguments: item.arguments },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${item.id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

// This transport/transcript boundary is not covered by the fake-clock watchdog unit tests.
it(
  "continues a failed Code Mode result after a provider request stalls before headers",
  { timeout: 60_000 },
  async ({ signal, onTestFailed }) => {
    const testStartedAt = performance.now();
    const phases: Record<string, number> = {};
    const fixture = await createFixture("openclaw-code-mode-stall-", TOKEN);
    const proxyEnv = captureEnv(["NO_PROXY", "no_proxy"]);
    const requests: ProviderRequest[] = [];
    const closedAfterMs: number[] = [];
    const firstStallClosed = createDeferred();
    const provider = createTrackedProvider(
      (raw, response, request) => {
        expect(request.url).toBe("/v1/responses");
        const body = JSON.parse(raw) as ProviderRequest;
        requests.push(body);
        expect(body.stream).toBe(true);
        if (requests.length === 1) {
          sendExec(response, false);
        } else if (requests.length === 2) {
          // No headers, data, or keepalives: only the real provider deadline can release this call.
          const startedAt = performance.now();
          response.once("close", () => {
            closedAfterMs.push(performance.now() - startedAt);
            firstStallClosed.resolve();
          });
        } else if (requests.length === 3) {
          sendExec(response, true);
        } else {
          expect(requests).toHaveLength(4);
          writeOpenAiResponsesText(response, {
            text: MARKER,
            messageId: "msg_recovered",
            responseId: "resp_recovered",
          });
        }
      },
      { signal },
    );
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    const events: Array<{ event?: string; payload?: unknown }> = [];
    onTestFailed(() => {
      // The e2e lane silences console calls, including diagnostics from a failed test.
      process.stderr.write(
        JSON.stringify({
          proof: "stall-recovery-progress",
          phases,
          requests: requests.length,
          closedAfterMs,
          providerErrors: provider.errors.map(String),
        }) + "\n",
      );
    });
    const recordPhase = (phase: string) => {
      phases[phase] = performance.now() - testStartedAt;
    };
    recordPhase("fixtureReadyMs");
    try {
      const baseUrl = await provider.listen();
      // Bypass an inherited outbound proxy only for this fixture endpoint, not the production guard.
      for (const key of ["NO_PROXY", "no_proxy"]) {
        setTestEnvValue(key, [process.env[key], new URL(baseUrl).host].filter(Boolean).join(","));
      }
      const providerModel = buildMockOpenAiResponsesProvider(baseUrl);
      const mock = { ...providerModel, config: { ...providerModel.config, timeoutSeconds: 2 } };
      const cfg = fixture.config(
        mock,
        {
          timeoutSeconds: 900,
          models: { [mock.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
        },
        { tools: { profile: "full", codeMode: { enabled: true, timeoutMs: 10_000 } } },
      );
      recordPhase("startupStartedMs");
      gateway = await startGatewayWithClient({
        cfg,
        configPath: fixture.configPath,
        token: TOKEN,
        onEvent: (event) => events.push(event),
      });
      await gateway.server.startupSettled;
      recordPhase("startupSettledMs");
      const sessionKey = "agent:main:code-mode-stall-recovery";
      const startedAt = performance.now();
      const started = await gateway.client.request<{ runId: string; status: string }>("chat.send", {
        sessionKey,
        message: "Run the synthetic Code Mode proof and finish with its result.",
        deliver: false,
        idempotencyKey: "code-mode-stall-recovery-run",
      });
      recordPhase("chatAcceptedMs");
      expect(started.status).toBe("started");
      const waited = await gateway.client.request<{
        status: string;
        error?: string;
        terminalReply?: { text?: string };
      }>("agent.wait", { runId: started.runId, timeoutMs: 30_000 }, { timeoutMs: 35_000 });
      recordPhase("agentWaitSettledMs");
      const elapsedMs = performance.now() - startedAt;
      expect(waited.status).toBe("ok");
      expect(elapsedMs).toBeLessThan(35_000);
      await withinTest(firstStallClosed.promise, signal);
      expect(requests).toHaveLength(4);
      expect(closedAfterMs).toHaveLength(1);
      for (const elapsed of closedAfterMs) {
        expect(elapsed).toBeGreaterThan(500);
        expect(elapsed).toBeLessThan(10_000);
      }
      const outputs = requests.map(
        (body) => body.input?.filter((item) => item.type === "function_call_output") ?? [],
      );
      expect(outputs.map((items) => items.length)).toEqual([0, 1, 1, 2]);
      const invalidOutput = outputs[1]?.[0]?.output;
      assert.ok(invalidOutput);
      expect(JSON.parse(invalidOutput)).toMatchObject({
        status: "failed",
        code: "invalid_input",
        failurePhase: "input",
        bridgeDispatchStarted: false,
        output: [],
      });
      for (const output of outputs.slice(2)) {
        expect(output[0]?.output).toBe(invalidOutput);
      }
      expect(events).toContainEqual(
        expect.objectContaining({
          event: "agent",
          payload: expect.objectContaining({
            stream: "run_status",
            data: expect.objectContaining({ phase: "retrying", reason: "timeout" }),
          }),
        }),
      );
      const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
        sessionKey,
        limit: 30,
      });
      const serialized = JSON.stringify(history.messages);
      const correctedOutput = outputs[3]?.[1]?.output;
      assert.ok(correctedOutput);
      expect(JSON.parse(correctedOutput)).toMatchObject({ status: "completed", value: 42 });
      expect(
        requests.map(
          (body) => body.input?.filter((item) => item.type === "function_call").length ?? 0,
        ),
      ).toEqual([0, 1, 1, 2]);
      expect(waited.terminalReply?.text).toBe(MARKER);
      expect(serialized).toContain(MARKER);
      console.log(
        JSON.stringify({
          proof: "stall-recovery",
          requests: requests.length,
          closedAfterMs,
          elapsedMs,
          status: waited.status,
        }),
      );
    } finally {
      try {
        await fixture.close(gateway, undefined);
        await provider.close();
      } finally {
        proxyEnv.restore();
      }
    }
  },
);
