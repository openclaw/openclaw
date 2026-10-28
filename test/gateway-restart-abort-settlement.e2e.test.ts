import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { asRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { GatewayClient } from "../src/gateway/client.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { createWorkerEnvironmentStore } from "../src/gateway/worker-environments/store.js";
import { writeGatewayRestartIntentSync } from "../src/infra/restart-intent.js";
import { extractFirstTextBlock } from "../src/shared/chat-message-content.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../src/state/openclaw-state-db.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import {
  connectRestartClient,
  restartEnv,
  restartModelConfig,
  restartToolNames,
  writeRestartPlugin,
  writeRestartTitle,
  writeRestartToolCall,
} from "./gateway-restart.test-support.js";
import { readRequestText } from "./helpers/gateway-integration-fixtures.js";
import { GATEWAY_RESTART_TEST_KILL_MS } from "./helpers/gateway-restart-budget.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { createDeferred, withinTest } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const key = (name: string) => `agent:main:shutdown-settlement-${name}`;
const marker = (name: string) => `SHUTDOWN_SETTLEMENT_${name}`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function historyToolOutput(messages: unknown[], name: string): unknown {
  const result = messages
    .flatMap((message) => {
      const entry = asRecord(message);
      return entry.role === "custom" && Array.isArray(entry.content) ? entry.content : [entry];
    })
    .find((entry) => isRecord(entry) && entry.role === "toolResult" && entry.toolName === name);
  expect(result).toBeDefined();
  return JSON.parse(extractFirstTextBlock(result) ?? "null");
}

function childProcessDiagnostic(pid: number) {
  const read = (name: "stat" | "status") => {
    try {
      return readFileSync(`/proc/${pid}/${name}`, "utf8");
    } catch (error) {
      return String(error);
    }
  };
  return JSON.stringify({ pid, stat: read("stat"), status: read("status") });
}

function toolCall(
  response: ServerResponse,
  tools: string[],
  name: string,
  args: object,
  ordinal: number,
) {
  const tool = tools.includes(name) ? name : "dispatch_action";
  expect(tools).toContain(tool);
  writeRestartToolCall(
    response,
    "settlement",
    tool,
    tool === "dispatch_action" ? { id: name, args } : args,
    ordinal,
  );
}

it(
  "settles recovered provisioning and restart-aborted nested/subagent lifecycle turns with a Git child",
  { timeout: 180_000 },
  async ({ signal }) => {
    const plainTurns = ["plain-1", "plain-2", "plain-3", "plain-4", "plain-5", "plain-6"];
    const ready = new Map(
      ["spawn", "child", "send", "nested", "exec", ...plainTurns, "provision"].map((name) => [
        name,
        createDeferred(),
      ]),
    );
    const wakeChild = createDeferred<ServerResponse>();
    const wakePending = createDeferred();
    const gitStarted = createDeferred<{ pid: number; gitPid: number }>();
    const failed = createDeferred<never>();
    void failed.promise.catch(() => {});
    const calls = new Map<string, number>();
    let ordinal = 0;
    let origin = "";
    const reservation = await reserveTestPortListener({
      signal,
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          void (async () => {
            if (request.url === "/provision-started") {
              ready.get("provision")!.resolve();
              return;
            }
            const body = asRecord(JSON.parse(await readRequestText(request)));
            if (request.url === "/git-started") {
              expect(body.pid).toBeTypeOf("number");
              expect(body.gitPid).toBeTypeOf("number");
              gitStarted.resolve({ pid: Number(body.pid), gitPid: Number(body.gitPid) });
              return;
            }
            expect(request.url).toBe("/v1/responses");
            const tools = restartToolNames(body);
            if (!tools.length) {
              if (body.stream === false) {
                writeRestartTitle(response, "Synthetic restart settlement");
                return;
              }
              writeOpenAiResponsesText(response, {
                text: "Synthetic restart settlement",
                messageId: "msg_title",
                responseId: "resp_title",
              });
              return;
            }
            const input = JSON.stringify(body.input);
            const name = input.includes("You are running as a subagent")
              ? input.includes(marker("wake-child"))
                ? "wake-child"
                : "child"
              : ["spawn", "send", "nested", "exec", ...plainTurns, "wake"].find((candidate) =>
                  input.includes(marker(candidate)),
                );
            if (!name) {
              throw new Error("Unexpected synthetic provider request");
            }
            const count = (calls.get(name) ?? 0) + 1;
            calls.set(name, count);
            ordinal++;
            if ((name === "spawn" || name === "wake") && count === 1) {
              toolCall(
                response,
                tools,
                "sessions_spawn",
                {
                  taskName: `shutdown_${name}_child`,
                  task: marker(name === "wake" ? "wake-child" : "child"),
                  context: "isolated",
                  cleanup: "keep",
                  expectsCompletionMessage: name === "wake",
                },
                ordinal,
              );
              return;
            }
            if (name === "wake-child") {
              wakeChild.resolve(response);
              return;
            }
            if (name === "wake") {
              if (count === 2) {
                toolCall(response, tools, "sessions_yield", {}, ordinal);
                return;
              }
              expect(count).toBe(3);
              expect(input).toContain(marker("wake-done"));
              wakePending.resolve();
            }
            if (name === "send" && count === 1) {
              toolCall(
                response,
                tools,
                "sessions_send",
                { sessionKey: key("nested"), message: marker("nested"), timeoutSeconds: 0 },
                ordinal,
              );
              return;
            }
            if (name === "exec" && count === 1) {
              const source = `fetch(${JSON.stringify(`${origin}/git-started`)},{method:"POST",body:JSON.stringify({pid:process.pid,gitPid:process.ppid})}).catch(()=>{})`;
              const alias = `!exec ${quote(process.execPath)} -e ${quote(source)}`;
              toolCall(
                response,
                tools,
                "exec",
                {
                  command: `git -c ${quote(`alias.hold=${alias}`)} hold`,
                  yieldMs: 10,
                  timeoutSeconds: 120,
                },
                ordinal,
              );
              return;
            }
            response.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
            });
            const id = `msg_hold_${ordinal}`;
            response.write(
              `data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id, role: "assistant", status: "in_progress", content: [] } })}\n\n`,
            );
            response.write(
              `data: ${JSON.stringify({ type: "response.output_text.delta", item_id: id, output_index: 0, content_index: 0, delta: `Waiting at ${name}` })}\n\n`,
            );
            ready.get(name)?.resolve();
          })().catch((error: unknown) => {
            failed.reject(error);
            response.destroy(error instanceof Error ? error : undefined);
          });
        }),
    });
    origin = `http://127.0.0.1:${reservation.claim.port}`;
    const model = buildMockOpenAiResponsesProvider(`${origin}/v1`);
    const instance = await createOpenClawTestInstance({
      name: "gateway-restart-abort-settlement",
      entrypoint: ["dist/index.js"],
      signal,
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
      gracefulShutdownTimeoutMs: GATEWAY_RESTART_TEST_KILL_MS,
      env: {
        ...restartEnv,
        OPENCLAW_NO_RESPAWN: "1",
      },
    });
    let client: GatewayClient | undefined;
    let phase = "configure";
    const gate = <T>(work: Promise<T>) => withinTest(Promise.race([work, failed.promise]), signal);
    await runQaGatewayFixture(
      async () => {
        try {
          const pluginId = "shutdown-provision";
          const pluginDir = instance.state.path("provision-plugin");
          await writeRestartPlugin(
            pluginDir,
            {
              id: pluginId,
              activation: { onStartup: true },
              contracts: { workerProviders: [pluginId] },
              configSchema: { type: "object", additionalProperties: false, properties: {} },
            },
            `export default {
              id: ${JSON.stringify(pluginId)},
              register(api) {
                api.registerWorkerProvider({
                  id: ${JSON.stringify(pluginId)},
                  supportedExecutionModes: ["remote-exec"],
                  provisionBeforeInstallation: true,
                  async resolveAllocation() {
                    return { leaseId: "shutdown-lease", sharedHost: false };
                  },
                  async provision(_profile, _operationId, options) {
                    await fetch(${JSON.stringify(`${origin}/provision-started`)}, {
                      method: "POST", signal: options?.signal,
                    });
                    throw new Error("Synthetic provisioning was released");
                  },
                  async inspect() { return { status: "unknown" }; },
                  async destroy() { throw new Error("Shutdown must preserve the allocation"); },
                });
              },
            };`,
          );
          await instance.state.writeConfig({
            update: { checkOnStart: false },
            browser: { enabled: false },
            discovery: { mdns: { mode: "off" } },
            plugins: {
              allow: [pluginId],
              load: { paths: [pluginDir] },
              entries: { [pluginId]: { enabled: true } },
              slots: { memory: "none" },
            },
            cloudWorkers: { profiles: { shutdown: { provider: pluginId, settings: {} } } },
            ...restartModelConfig(
              model,
              instance.state.workspaceDir,
              { maxConcurrent: 16 },
              { catalogRefresh: { enabled: false } },
            ),
            tools: {
              allow: ["exec", "process", "sessions_spawn", "sessions_yield", "sessions_send"],
              exec: { mode: "full", host: "gateway" },
              codeMode: { enabled: false },
              sessions: { visibility: "all" },
            },
            gateway: {
              mode: "local",
              bind: "loopback",
              port: instance.port,
              auth: { mode: "token", token: instance.gatewayToken },
              controlUi: { enabled: false },
            },
          });
          // Recover an interrupted allocation through the real startup reconciler.
          const database = openOpenClawStateDatabase({ env: instance.env });
          try {
            const store = await createWorkerEnvironmentStore({ database });
            await store.createIntent({
              environmentId: "shutdown-provision",
              providerId: pluginId,
              profileId: "shutdown",
              profileSnapshot: { settings: {} },
              provisionOperationId: "shutdown-provision-operation",
            });
            await store.transition({
              environmentId: "shutdown-provision",
              from: "requested",
              to: "provisioning",
            });
          } finally {
            await closeOpenClawStateDatabaseByPathAsync(database.path);
          }
          phase = "start";
          await instance.startGateway();
          client = await connectRestartClient(instance, { mode: "test" }, signal);
          for (const name of ["nested", "spawn", "send", "exec", ...plainTurns, "wake"]) {
            await client.request("sessions.create", {
              key: key(name),
              agentId: "main",
              model: model.modelRef,
              permissionMode: "full",
            });
          }
          phase = "admit";
          for (const name of ["spawn", "send", "exec", ...plainTurns, "wake"]) {
            await client.request(
              "agent",
              {
                agentId: "main",
                sessionKey: key(name),
                message: marker(name),
                idempotencyKey: name,
                deliver: false,
                timeout: 120,
              },
              { expectFinal: false },
            );
          }
          phase = "wait-active";
          await gate(Promise.all([...ready.values()].map((deferred) => deferred.promise)));
          const childPids = await gate(gitStarted.promise);
          const senderHistory = await client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: key("send"),
          });
          expect(historyToolOutput(senderHistory.messages, "sessions_send")).toMatchObject({
            status: "accepted",
            targetDisposition: "queued",
            delivery: { status: "pending" },
          });
          const wakeResponse = await gate(wakeChild.promise);
          const observer = client;
          await gate(
            vi.waitFor(
              async () => {
                const history = await observer.request<{ messages: unknown[] }>("chat.history", {
                  sessionKey: key("wake"),
                });
                expect(historyToolOutput(history.messages, "sessions_yield")).toMatchObject({
                  status: "yielded",
                });
              },
              { timeout: 30_000 },
            ),
          );
          // Complete only after the parent yielded; its next model request is a lifecycle wake.
          writeOpenAiResponsesText(wakeResponse, {
            text: marker("wake-done"),
            messageId: "msg_wake_child_done",
            responseId: "resp_wake_child_done",
          });
          await gate(wakePending.promise);
          phase = "restart";
          await client.stopAndWait();
          client = undefined;
          const child = instance.child!;
          const closed = once(child, "close");
          expect(
            writeGatewayRestartIntentSync({
              env: instance.env,
              targetPid: child.pid!,
              intent: { reason: "gateway.restart", force: true, waitMs: 100 },
            }),
          ).toBe(true);
          const shutdownStartedAt = Date.now();
          expect(child.kill("SIGTERM")).toBe(true);
          expect(await gate(closed), instance.logs()).toEqual([0, null]);
          expect(Date.now() - shutdownStartedAt, instance.logs()).toBeLessThan(5_000);
          expect(instance.logs()).toMatch(
            /completed in \d+ms with warnings: restart-reply-drain\b/u,
          );
          expect(instance.logs()).not.toContain("shutdown deadline reached");
          expect(instance.logs()).not.toContain(
            "In-process gateway dispatch requires a current gateway instance binding",
          );
          for (const pid of [childPids.pid, childPids.gitPid]) {
            try {
              expect(() => process.kill(pid, 0)).toThrow();
            } catch (cause) {
              throw new Error(`Child remains after shutdown: ${childProcessDiagnostic(pid)}`, {
                cause,
              });
            }
          }
        } catch (cause) {
          throw new Error(
            JSON.stringify({
              phase,
              calls: Object.fromEntries(calls),
              logs: instance.logs(),
            }).replaceAll(instance.gatewayToken, "[fixture token]"),
            { cause },
          );
        }
      },
      () => client?.stopAndWait(),
      () => instance.cleanup(),
      async () => {
        reservation.listener.closeAllConnections();
        await reservation.releaseListener();
        await reservation.claim.release();
      },
    );
  },
);
