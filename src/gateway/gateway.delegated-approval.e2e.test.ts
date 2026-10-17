import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, onTestFailed } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  closeProvider,
  listenProvider,
  readProviderBody,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

const PROVIDER = "delegated-approval-proof";
const cleanups: Array<() => Promise<void>> = [];
type Delegation = "sessions_send" | "sessions_spawn";
type ApprovalEvent = { id: string; request: { command: string; sessionKey?: string } };

function scenario(tool: Delegation, approvals: boolean) {
  return {
    tool,
    approvals,
    id: randomUUID(),
    approval: createDeferred<ApprovalEvent>(),
    denied: createDeferred<string>(),
    executed: createDeferred<string>(),
    errors: createDeferred<never>(),
    childCalledExec: false,
    calls: [] as string[],
    approvalsSeen: [] as ApprovalEvent[],
    registeredId: undefined as string | undefined,
  };
}

function textResponse(response: ServerResponse, text: string): void {
  writeOpenAiResponsesText(response, {
    text,
    messageId: `msg_${randomUUID()}`,
    responseId: `resp_${randomUUID()}`,
  });
}

function model(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    api: "openai-responses",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 4_096,
  };
}

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  resetGatewayTestState();
  if (errors.length) {
    throw new AggregateError(errors, "delegated approval proof cleanup failed");
  }
});

describe("delegated approval through real workers", () => {
  // This intentionally crosses the real admission, worker RPC, approval owner,
  // and command execution boundaries. Only the external model is scripted.
  it.skipIf(process.platform === "win32")(
    "executes approved send/spawn work and refuses write-only descendants",
    {
      timeout: 180_000,
    },
    async (testContext) => {
      let active = scenario("sessions_send", true);
      const scenarios: ReturnType<typeof scenario>[] = [];
      const provider = createServer((request, response) => {
        void (async () => {
          if (request.method === "GET" && request.url === "/v1/models") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ data: ["parent", "child"].map((id) => ({ id, object: "model" })) }),
            );
            return;
          }
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const raw = await readProviderBody(request);
          const body = JSON.parse(raw) as { model: string; input?: unknown[] };
          // Inspect input only: tool descriptions must never satisfy outcome assertions.
          const input = JSON.stringify(body.input ?? []);
          const current = scenarios.findLast((candidate) => input.includes(candidate.id));
          if (!current) {
            textResponse(response, "No further action.");
            return;
          }
          if (body.model === "parent") {
            current.calls.push("parent");
            if (
              input.includes("function_call_output") ||
              !input.includes(`DELEGATE_${current.id}`)
            ) {
              textResponse(response, "Delegation acknowledged.");
            } else {
              writeToolCall(
                response,
                current.tool,
                current.tool === "sessions_send"
                  ? {
                      sessionKey: `agent:target:proof-${current.id}`,
                      message: `EXECUTE_${current.id}`,
                      timeoutSeconds: 0,
                    }
                  : {
                      agentId: "target",
                      task: `EXECUTE_${current.id}`,
                      mode: "run",
                      cleanup: "keep",
                      runTimeoutSeconds: 60,
                    },
              );
            }
            return;
          }
          if (body.model !== "child") {
            throw new Error(`unexpected fixture model: ${body.model}`);
          }
          current.calls.push("child");
          const receipt = [
            ...input.matchAll(/Exec finished \(gateway id=([^,\s]+), session=[^,\s]+, code 0\)/g),
          ].find((match) => match[1] === current.registeredId)?.[0];
          if (receipt) {
            current.executed.resolve(receipt);
            textResponse(response, "Command execution observed.");
          } else if (input.includes("missing scope: operator.approvals")) {
            current.denied.resolve(input);
            textResponse(response, "Approval registration refused.");
          } else if (!current.childCalledExec) {
            current.childCalledExec = true;
            writeToolCall(response, "exec", {
              command: `/usr/bin/true ${current.id}`,
              host: "gateway",
              security: "allowlist",
              ask: "always",
              timeoutSeconds: 5,
            });
          } else {
            textResponse(response, "Waiting for the operator decision.");
          }
        })().catch((error: unknown) => {
          active.errors.reject(error);
          response.writeHead(500).end("fixture request failed");
        });
      });
      const baseUrl = await listenProvider(provider);
      cleanups.push(() => closeProvider(provider));
      resetGatewayTestState();
      const { tempHome, workspaceDir, envSnapshot } = await setupGatewayTempHome({
        prefix: "openclaw-delegated-approval-",
      });
      cleanups.push(() => removeGatewayTempHome(tempHome));
      cleanups.push(async () => envSnapshot.restore());
      const configPath = await createGatewayConfigPath(tempHome);
      const token = `approval-proof-${randomUUID()}`;
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      deleteTestEnvValue("OPENCLAW_TEST_GATEWAY_OVERRIDE_TOKEN");
      deleteTestEnvValue("OPENCLAW_TEST_RUNTIME_OVERRIDE_TOKEN");
      const cfg = {
        agents: {
          ownership: "explicit",
          defaults: {
            workspace: workspaceDir,
            skipBootstrap: true,
            skills: [],
            model: { primary: `${PROVIDER}/parent` },
            models: { [`${PROVIDER}/parent`]: {}, [`${PROVIDER}/child`]: {} },
            subagents: { allowAgents: ["target"] },
          },
          entries: { sender: {}, target: { model: { primary: `${PROVIDER}/child` } } },
        },
        gateway: { auth: { mode: "token", token } },
        hooks: { enabled: false },
        models: {
          mode: "replace",
          providers: {
            [PROVIDER]: {
              baseUrl,
              apiKey: "test-token-placeholder",
              api: "openai-responses",
              request: { allowPrivateNetwork: true },
              models: [model("parent"), model("child")],
            },
          },
        },
        plugins: { slots: { memory: "none" } },
        tools: {
          profile: "full",
          codeMode: false,
          toolSearch: false,
          sessions: { visibility: "all" },
          agentToAgent: { enabled: true, allow: ["*"] },
          exec: { host: "gateway", security: "allowlist", ask: "always" },
        },
      } satisfies OpenClawConfig;
      const gateway = await startGatewayWithClient({
        cfg,
        configPath,
        token,
        scopes: ["operator.admin"],
      });
      cleanups.push(async () => {
        try {
          await disconnectGatewayClient(gateway.client);
        } finally {
          await gateway.server.close({ reason: "delegated approval proof complete" });
        }
      });
      const url = `ws://127.0.0.1:${gateway.port}`;
      const reviewer = await connectGatewayClient({
        url,
        token,
        scopes: ["operator.admin"],
        caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
        onEvent: (event) => {
          if (event.event === "exec.approval.requested") {
            const approval = event.payload as ApprovalEvent;
            const current = scenarios.find(
              (candidate) => approval.request.command === `/usr/bin/true ${candidate.id}`,
            );
            if (current) {
              current.registeredId = approval.id;
              current.approvalsSeen.push(approval);
              current.approval.resolve(approval);
            }
          }
        },
      });
      cleanups.push(() => disconnectGatewayClient(reviewer));
      onTestFailed(() => {
        process.stderr.write(
          `delegated approval proof: ${JSON.stringify({ tool: active.tool, approvals: active.approvals, calls: active.calls, registered: active.approvalsSeen.length })}\n`,
        );
      });
      for (const tool of ["sessions_send", "sessions_spawn"] as const) {
        for (const approvals of [true, false]) {
          active = scenario(tool, approvals);
          scenarios.push(active);
          const requester = await connectGatewayClient({
            url,
            token,
            scopes: approvals ? ["operator.write", "operator.approvals"] : ["operator.write"],
          });
          try {
            if (tool === "sessions_send") {
              const key = `agent:target:proof-${active.id}`;
              await expect(
                gateway.client.request("sessions.create", { agentId: "target", key }),
              ).resolves.toMatchObject({ ok: true, key, runStarted: false });
            }
            const runId = randomUUID();
            await requester.request(
              "agent",
              {
                sessionKey: `agent:sender:proof-${active.id}`,
                message: `DELEGATE_${active.id}`,
                deliver: false,
                idempotencyKey: runId,
              },
              { expectFinal: false },
            );
            const awaitOutcome = <T>(promise: Promise<T>) =>
              withinTest(Promise.race([promise, active.errors.promise]), testContext.signal);
            if (approvals) {
              const pending = await awaitOutcome(
                Promise.race([
                  active.approval.promise,
                  active.denied.promise.then((): never => {
                    throw new Error("capable descendant lost approval scope");
                  }),
                ]),
              );
              expect(pending.request.command).toBe(`/usr/bin/true ${active.id}`);
              await reviewer.request("exec.approval.resolve", {
                id: pending.id,
                decision: "allow-once",
              });
              const receipt = await awaitOutcome(active.executed.promise);
              expect(receipt.startsWith(`Exec finished (gateway id=${pending.id}, session=`)).toBe(
                true,
              );
              expect(receipt.endsWith(", code 0)")).toBe(true);
              expect(active.approvalsSeen).toHaveLength(1);
            } else {
              const denial = await awaitOutcome(active.denied.promise);
              expect(denial).toContain("missing scope: operator.approvals");
              expect(active.approvalsSeen).toHaveLength(0);
            }
            await expect(
              gateway.client.request("agent.wait", { runId, timeoutMs: 20_000 }),
            ).resolves.toMatchObject({ status: "ok" });
            process.stdout.write(
              `delegated approval proof: ${tool} ${approvals ? "registered -> allow-once -> exec exit 0" : "write-only -> approval registration denied"}\n`,
            );
          } finally {
            await disconnectGatewayClient(requester);
          }
        }
      }
    },
  );
});
