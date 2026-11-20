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
  "observes a new recovery input, not execution continuation, after death mid-tool",
  { timeout: 120_000 },
  async ({ signal, onTestFailed }) => {
    const held = createDeferred<void>();
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    let calls = 0;
    let restarting = false;
    let resumes = 0;
    let resumedInput = "";
    const reservation = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        restartProviderServer(failed, async (request, response, body) => {
          if (request.url === "/held") {
            held.resolve();
            return;
          }
          const input = JSON.stringify(body.input);
          const tools = restartToolNames(body);
          if (!tools.length) {
            writeRestartJsonText(response, "Synthetic crash proof", "title");
            return;
          }
          calls++;
          if (restarting) {
            resumes++;
            resumedInput = input;
            expect(input).toContain("The Gateway restarted while you were working.");
            writeOpenAiResponsesText(response, {
              text: "RECOVERY_INPUT_FINISHED",
              messageId: "msg_recovery",
              responseId: "resp_recovery",
            });
            return;
          }
          const name = calls === 1 ? "proof_complete" : "proof_hold";
          expect(calls).toBeLessThanOrEqual(2);
          const wire = tools.includes(name) ? name : "dispatch_action";
          expect(tools).toContain(wire);
          writeRestartToolCall(
            response,
            "crash",
            wire,
            wire === name ? {} : { id: name, args: {} },
            calls,
          );
        }),
    });
    const base = "http://127.0.0.1:" + reservation.claim.port;
    const config = restartResumeConfig(buildMockOpenAiResponsesProvider(base + "/v1"));
    const instance = await createOpenClawTestInstance({
      name: "mid-tool-crash-proof",
      signal,
      config,
      env: { ...restartEnv, OPENCLAW_NO_RESPAWN: "1" },
    });
    const effects = instance.state.path("effects.log");
    const pluginDir = instance.state.path("crash-proof-plugin");
    await writeRestartPlugin(
      pluginDir,
      {
        id: "crash-proof",
        contracts: { tools: ["proof_complete", "proof_hold"] },
        activation: { onStartup: true },
        configSchema: { type: "object", properties: {} },
      },
      'import {appendFile} from "node:fs/promises";\n' +
        'export default { id: "crash-proof", register(api) {\n' +
        'const tool = (name, execute) => api.registerTool({name, label:name, description:name, parameters:{type:"object",properties:{},additionalProperties:false}, execute});\n' +
        'tool("proof_complete", async () => { await appendFile(' +
        JSON.stringify(effects) +
        ', "completed-side-effect\\n"); return {content:[{type:"text",text:"COMPLETED_EFFECT_RECEIPT"}]}; });\n' +
        'tool("proof_hold", async () => { await appendFile(' +
        JSON.stringify(effects) +
        ', "in-flight-side-effect\\n"); await fetch(' +
        JSON.stringify(base + "/held") +
        ', {method:"POST",body:"{}"}); await appendFile(' +
        JSON.stringify(effects) +
        ', "original-execution-resumed\\n"); return {content:[{type:"text",text:"UNREACHABLE"}]}; });\n' +
        "} };",
    );
    await instance.state.writeConfig({
      ...JSON.parse(await readFile(instance.configPath, "utf8")),
      plugins: {
        enabled: true,
        load: { paths: [pluginDir] },
        allow: ["crash-proof", "openai"],
        slots: { memory: "none" },
        entries: { "crash-proof": { enabled: true } },
      },
      tools: { ...config.tools, allow: ["proof_complete", "proof_hold"] },
    });
    let client: Awaited<ReturnType<typeof connectRestartClient>> | undefined;
    const key = "agent:main:main:thread:mid-tool-crash-proof";
    onTestFailed(() => process.stderr.write(instance.logs()));
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        client = await connectRestartClient(instance, {}, signal);
        await client.request("sessions.create", { key, agentId: "main" });
        await client.request("chat.send", {
          sessionKey: key,
          message: "Perform the two synthetic proof tools.",
          idempotencyKey: randomUUID(),
        });
        await Promise.race([held.promise, failed.promise]);
        expect(await readFile(effects, "utf8")).toBe(
          "completed-side-effect\nin-flight-side-effect\n",
        );
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
            expect(JSON.stringify(history.messages)).toContain("RECOVERY_INPUT_FINISHED");
            expect(history.sessionInfo.hasActiveRun).toBe(false);
          },
          { timeout: 20_000 },
        );
        expect(resumes).toBe(1);
        expect(resumedInput).toContain("COMPLETED_EFFECT_RECEIPT");
        expect(await readFile(effects, "utf8")).toBe(
          "completed-side-effect\nin-flight-side-effect\n",
        );
        process.stdout.write(
          "[mid-tool-crash-proof] " +
            JSON.stringify({
              signal: "SIGKILL",
              preCrashModelCalls: calls - resumes,
              recoveryModelCalls: resumes,
              completedEffects: 1,
              uncertainInFlightEffects: 1,
              originalExecutionResumed: false,
              completedReceiptRetained: true,
              recoveryIsNewInput: true,
              provider: "scripted-local",
              authority: "synthetic-test-client/session-principal",
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
