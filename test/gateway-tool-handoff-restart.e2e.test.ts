import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import {
  connectRestartClient,
  restartEnv,
  restartModelConfig,
  restartProviderServer,
  restartToolNames,
  writeRestartJsonText,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it.skipIf(process.platform === "win32")(
  "resumes a tool-handoff result after process death without repeating the tool",
  { timeout: 180_000 },
  async (context) => {
    const { signal } = context;
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    const handoffStarted = createDeferred();
    const recovered = createDeferred();
    const release = createDeferred();
    const sessionKey = "agent:main:dashboard:tool-handoff-restart";
    const final = "TOOL_HANDOFF_RECOVERED_RESULT";
    let effectPath = "";
    let calls = 0;
    let reloadCalls = 0;
    const race = <T>(work: Promise<T>) => withinTest(Promise.race([work, failed.promise]), signal);
    const provider = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () =>
        restartProviderServer(
          failed,
          async (_request, response, body) => {
            const text = (value: string) => {
              if (body.stream === false) {
                writeRestartJsonText(response, value, `handoff_text_${calls}`);
              } else {
                writeOpenAiResponsesText(response, {
                  text: value,
                  messageId: `msg_handoff_text_${calls}`,
                  responseId: `resp_handoff_text_${calls}`,
                });
              }
            };
            if (restartToolNames(body).length === 0) {
              text("Synthetic handoff title");
              return;
            }
            const input = JSON.stringify(body.input);
            const callTool = (name: string, args: object) => {
              const tools = restartToolNames(body);
              const wireName = tools.includes(name) ? name : "dispatch_action";
              expect(tools).toContain(wireName);
              writeRestartToolCall(
                response,
                "handoff",
                wireName,
                wireName === "dispatch_action" ? { id: name, args } : args,
                calls,
              );
            };
            expect(++calls).toBeLessThanOrEqual(4);
            if (calls === 1) {
              reloadCalls++;
              // A failed mutation still has a real result and an owned continuation.
              // Reloading a nonexistent plugin avoids any external publication effect.
              callTool("plugins", {
                action: "reloadAndResume",
                pluginId: "synthetic-nonexistent-plugin",
              });
            } else if (calls === 2) {
              expect(input).toContain("Plugin reload result:");
              handoffStarted.resolve();
            } else if (calls === 3) {
              expect(input).toContain("interrupted by a gateway restart");
              recovered.resolve();
              await withinTest(release.promise, signal);
              callTool("exec", {
                command: `printf recovered >> ${JSON.stringify(effectPath)}`,
              });
            } else {
              expect(await readFile(effectPath, "utf8")).toBe("recovered");
              text(final);
            }
          },
          { ignoreAborted: true },
        ),
    });
    const noProxy = [process.env.no_proxy ?? process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"]
      .filter(Boolean)
      .join(",");
    const instance = await createOpenClawTestInstance({
      name: "gateway-tool-handoff-restart",
      signal,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
      env: { ...restartEnv, NO_PROXY: noProxy, no_proxy: noProxy, OPENCLAW_NO_RESPAWN: "1" },
    });
    instance.env.OPENCLAW_GATEWAY_PORT = String(instance.port);
    effectPath = path.join(instance.state.workspaceDir, "recovered-effect");
    const model = buildMockOpenAiResponsesProvider(`http://127.0.0.1:${provider.claim.port}/v1`);
    await instance.state.writeConfig({
      update: { checkOnStart: false },
      browser: { enabled: false },
      discovery: { mdns: { mode: "off" } },
      plugins: { enabled: false },
      logging: { file: path.join(instance.state.root, "gateway.log") },
      ...restartModelConfig(
        model,
        instance.state.workspaceDir,
        {},
        { catalogRefresh: { enabled: false } },
      ),
      tools: {
        allow: ["plugins", "exec"],
        codeMode: { enabled: false },
        exec: { host: "gateway", security: "full", ask: "off" },
      },
      gateway: {
        mode: "local",
        controlUi: { enabled: false },
        bind: "loopback",
        port: instance.port,
        auth: { mode: "token", token: instance.gatewayToken },
      },
    });
    let client: GatewayClient | undefined;
    context.onTestFailed(() =>
      console.error(instance.logs().replaceAll(instance.gatewayToken, "[fixture token]")),
    );
    await runQaGatewayFixture(
      async () => {
        await instance.startGateway();
        const originalPid = instance.child?.pid;
        client = await connectRestartClient(instance, { mode: "test" }, signal);
        await client.request("sessions.create", {
          key: sessionKey,
          agentId: "main",
          permissionMode: "full",
        });
        await client.request(
          "chat.send",
          {
            sessionKey,
            idempotencyKey: randomUUID(),
            message: "Continue after the synthetic plugin reload result.",
          },
          { expectFinal: false },
        );
        await race(handoffStarted.promise);
        await client.stopAndWait();
        client = undefined;
        await instance.crashGateway();
        await instance.startGateway();
        expect(instance.child?.pid).not.toBe(originalPid);
        client = await connectRestartClient(instance, { mode: "test" }, signal);
        await race(recovered.promise);
        release.resolve();
        await race(
          vi.waitFor(
            async () => {
              const history = JSON.stringify(await client!.request("chat.history", { sessionKey }));
              expect(history).toContain(final);
              expect(history).not.toContain("no matching operator authority");
              const rows = await client!.request<SessionsListResult>("sessions.list", {
                agentId: "main",
              });
              expect(rows.sessions.find((row) => row.key === sessionKey)).toMatchObject({
                status: "done",
                hasActiveRun: false,
              });
            },
            { timeout: 30_000 },
          ),
        );
        expect(calls).toBe(4);
        expect(reloadCalls).toBe(1);
        expect(await readFile(effectPath, "utf8")).toBe("recovered");
      },
      () => client?.stopAndWait(),
      () => instance.cleanup(),
      async () => {
        release.resolve();
        provider.listener.closeAllConnections();
        await provider.releaseListener();
        await provider.claim.release();
      },
    );
  },
);
