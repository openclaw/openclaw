import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { restartResumeConfig } from "./gateway-restart-resume.test-support.js";
import {
  connectRestartClient,
  restartEnv,
  restartProviderServer,
  restartToolNames,
  writeRestartPlugin,
  writeRestartToolCall,
  writeRestartJsonText,
} from "./gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it(
  "recovers the original durable cell after SIGKILL without repeating committed effects",
  { timeout: 180_000 },
  async ({ signal, onTestFailed }) => {
    const held = createDeferred<void>();
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    let restarting = false;
    let modelCalls = 0;
    let readCalls = 0;
    let recoveredInput = "";
    const reservation = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        restartProviderServer(failed, async (request, response, body) => {
          if (request.url === "/held") {
            readCalls++;
            if (!restarting) {
              held.resolve();
              return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ receipt: "B_RECOVERED" }));
            return;
          }
          const tools = restartToolNames(body);
          if (!tools.length) {
            writeRestartJsonText(response, "Durable cell proof", "title");
            return;
          }
          modelCalls++;
          if (restarting) {
            recoveredInput = JSON.stringify(
              Array.isArray(body.input)
                ? body.input.filter(
                    (entry: { type?: string; role?: string }) =>
                      entry.type === "function_call_output" || entry.role === "tool",
                  )
                : body.input,
            );
            // Assert the recovered result after settlement, not merely the original assistant code.
            writeOpenAiResponsesText(response, {
              text: "DURABLE_RECOVERY_FINISHED",
              messageId: "msg_recovered",
              responseId: "resp_recovered",
            });
            return;
          }
          expect(modelCalls).toBe(1);
          expect(tools).toContain("exec");
          writeRestartToolCall(
            response,
            "durable",
            "exec",
            {
              code: 'const a = await proof_a({}); const b = await proof_b({}); await proof_c({}); return {marker: "DURABLE_CELL_COMPLETED", a, b, random: Math.random(), now: Date.now()};',
              awaitResults: true,
            },
            1,
          );
        }),
    });
    const base = "http://127.0.0.1:" + reservation.claim.port;
    const config = restartResumeConfig(buildMockOpenAiResponsesProvider(base + "/v1"));
    const instance = await createOpenClawTestInstance({
      name: "durable-code-mode-proof",
      signal,
      config,
      env: { ...restartEnv, OPENCLAW_NO_RESPAWN: "1" },
    });
    const effects = instance.state.path("effects.log");
    const pluginDir = instance.state.path("durable-proof-plugin");
    await writeRestartPlugin(
      pluginDir,
      {
        id: "durable-proof",
        contracts: { tools: ["proof_a", "proof_b", "proof_c"] },
        toolMetadata: { proof_b: { replaySafe: true } },
        activation: { onStartup: true },
        configSchema: { type: "object", properties: {} },
      },
      [
        'import {appendFile} from "node:fs/promises";',
        'export default { id: "durable-proof", register(api) {',
        'const result = (value) => ({content:[{type:"text",text:JSON.stringify(value)}],details:value});',
        'const tool = (name, execute) => api.registerTool({name,label:name,description:name,parameters:{type:"object",properties:{},additionalProperties:false},execute});',
        'tool("proof_a", async () => { await appendFile(' +
          JSON.stringify(effects) +
          ', "A\\n"); return result({receipt:"A_COMMITTED"}); });',
        'tool("proof_b", async () => result(await (await fetch(' +
          JSON.stringify(base + "/held") +
          ', {method:"POST",body:"{}"})).json()));',
        'tool("proof_c", async () => { await appendFile(' +
          JSON.stringify(effects) +
          ', "C\\n"); return result({receipt:"C_COMMITTED"}); });',
        "} };",
      ].join("\n"),
    );
    await instance.state.writeConfig({
      ...JSON.parse(await readFile(instance.configPath, "utf8")),
      plugins: {
        enabled: true,
        load: { paths: [pluginDir] },
        allow: ["durable-proof", "code-mode-quickjs", "openai"],
        slots: { memory: "none" },
        entries: { "durable-proof": { enabled: true }, "code-mode-quickjs": { enabled: true } },
      },
      tools: {
        ...config.tools,
        allow: ["proof_a", "proof_b", "proof_c"],
        codeMode: { enabled: true, executor: "quickjs", timeoutMs: 30_000 },
      },
    });
    let client: Awaited<ReturnType<typeof connectRestartClient>> | undefined;
    const key = "agent:main:main:thread:durable-code-mode-proof";
    onTestFailed(() => process.stderr.write(instance.logs()));
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        await client.request("sessions.create", { key, agentId: "main" });
        await client.request("chat.send", {
          sessionKey: key,
          message: "Run the synthetic durable cell.",
          idempotencyKey: randomUUID(),
        });
        await Promise.race([held.promise, failed.promise]);
        expect(await readFile(effects, "utf8")).toBe("A\n");
        await instance.crashGateway();
        await client.stopAndWait();
        client = undefined;
        restarting = true;
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        await vi.waitFor(
          async () => {
            const history = await client!.request<{
              messages: unknown[];
              sessionInfo: { hasActiveRun: boolean };
            }>("chat.history", { sessionKey: key });
            expect(JSON.stringify(history.messages)).toContain("DURABLE_RECOVERY_FINISHED");
            expect(history.sessionInfo.hasActiveRun).toBe(false);
          },
          { timeout: 30_000 },
        );
        process.stdout.write("[durable-recovered-output] " + recoveredInput.slice(-3000) + "\n");
        expect(await readFile(effects, "utf8")).toBe("A\nC\n");
        expect(readCalls).toBe(2);
        expect(modelCalls).toBe(2);
        expect(recoveredInput).toContain("A_COMMITTED");
        expect(recoveredInput).toContain("B_RECOVERED");
        process.stdout.write(
          "[durable-code-mode-proof] " +
            JSON.stringify({
              signal: "SIGKILL",
              committedEffects: 1,
              replayedSafeReads: 1,
              continuationEffects: 1,
              finalResults: 1,
              provider: "scripted-local",
              authority: "synthetic-original-requester",
            }) +
            "\n",
        );
      },
      async () => {
        await client?.stopAndWait();
      },
      () => instance.cleanup(),
      async () => {
        reservation.listener.closeAllConnections();
      },
      reservation.releaseListener,
      reservation.claim.release,
    );
  },
);
