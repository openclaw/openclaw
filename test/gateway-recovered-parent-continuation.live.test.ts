// A real process kill distinguishes restored operator custody from a live request.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { isLiveTestEnabled, logLiveProgress } from "../src/agents/live-test-helpers.js";
import { createExternalGates } from "../src/agents/subagents/announce/subagent-external-gate.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { redactSecrets } from "../src/logging/redact.js";
import { extractAssistantPhaseText } from "../src/shared/chat-message-content.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

function fetchCommand(url: string) {
  const source = `const r = await fetch(${JSON.stringify(url)}); if (!r.ok) throw new Error(String(r.status)); console.log(await r.text());`;
  return [process.execPath, "--input-type=module", "-e", source]
    .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
    .join(" ");
}

it.skipIf(!isLiveTestEnabled() || process.platform === "win32")(
  "lets a child finish after its SIGKILL-recovered parent completes",
  { timeout: 600_000 },
  async ({ signal }) => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("Recovered-parent live proof requires OPENAI_API_KEY");
    }
    const modelRef = "openai/gpt-5.6-sol";
    const instance = await createOpenClawTestInstance({
      name: "recovered-parent-continuation",
      signal,
      env: {
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: undefined,
        OPENAI_API_BASE: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
      },
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
    });
    const gates = await createExternalGates();
    const parentGate = gates.create();
    const childGate = gates.create();
    const parentKey = `agent:main:recovered-parent-${randomUUID()}`;
    const parentFinal = `PARENT_COMPLETE_${randomUUID()}`;
    const childFinal = `CHILD_COMPLETE_${randomUUID()}`;
    let client: GatewayClient | undefined;
    let succeeded = false;
    await runQaGatewayFixture(
      async () => {
        await instance.state.writeConfig({
          secrets: { providers: { default: { source: "env" } } },
          models: {
            mode: "replace",
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [
                  {
                    id: "gpt-5.6-sol",
                    name: "GPT-5.6 Sol",
                    reasoning: true,
                    input: ["text"],
                    contextWindow: 128_000,
                    maxTokens: 8_192,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
          agents: {
            defaults: {
              workspace: instance.state.workspaceDir,
              model: { primary: modelRef },
              modelPolicy: { allow: [modelRef] },
              models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
              thinkingDefault: "low",
              skipBootstrap: true,
              skills: [],
              timeoutSeconds: 300,
              subagents: { allowAgents: ["*"], runTimeoutSeconds: 300 },
            },
            entries: { main: {} },
          },
          tools: {
            allow: ["sessions_spawn", "exec", "process"],
            codeMode: { enabled: false },
            exec: { mode: "full", host: "gateway" },
          },
          plugins: { enabled: false },
          gateway: {
            mode: "local",
            bind: "loopback",
            port: instance.port,
            auth: { mode: "token", token: instance.gatewayToken },
            controlUi: { enabled: false },
          },
        });
        instance.state.applyEnv();
        const connect = () =>
          acquireGatewayTestClient(
            {
              url: instance.url,
              token: instance.gatewayToken,
              deviceIdentity: null,
              clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
              mode: GATEWAY_CLIENT_MODES.BACKEND,
              scopes: ["operator.admin", "operator.read", "operator.write"],
              requestTimeoutMs: 180_000,
            },
            {
              timeoutMs: 60_000,
              timeoutMessage: "Recovered-parent Gateway connect timeout",
              closeMessage: "Recovered-parent Gateway closed during connect",
            },
          );
        const history = async (sessionKey: string) => {
          const result = await client!.request<{ messages: Record<string, unknown>[] }>(
            "chat.history",
            { sessionKey },
          );
          return result.messages
            .filter((message) => message.role === "assistant")
            .map((message) => extractAssistantPhaseText(message)?.trim());
        };
        await instance.startGateway();
        client = await connect();
        await client.request("sessions.create", {
          key: parentKey,
          agentId: "main",
          model: modelRef,
          permissionMode: "full",
          cwd: instance.state.workspaceDir,
        });
        expect(await history(parentKey)).toEqual([]);
        const task = [
          `Run ${fetchCommand(childGate.url)} with exec, timeoutSeconds 240.`,
          "If it returns a running session, wait using process until it finishes.",
          "Do not spawn or write files. Reply with exactly the command stdout.",
        ].join("\n");
        logLiveProgress("recovered parent: holding original turn before SIGKILL");
        await client.request("agent", {
          sessionKey: parentKey,
          idempotencyKey: randomUUID(),
          deliver: false,
          message: [
            `First run ${fetchCommand(parentGate.url)} with exec, timeoutSeconds 240.`,
            "Wait for its stdout; if interrupted by a Gateway restart, retry only that read-only HTTP command.",
            `Then call sessions_spawn exactly once with ${JSON.stringify({ taskName: "detached_worker", task, cleanup: "keep", context: "isolated", expectsCompletionMessage: false })}.`,
            `Immediately after spawn acceptance, reply exactly ${parentFinal}. Do not yield or wait for the child.`,
          ].join("\n"),
        });
        await vi.waitFor(() => expect(parentGate.snapshot().waiting).toBeGreaterThan(0), {
          timeout: 180_000,
        });
        await client.stopAndWait();
        client = undefined;
        const original = instance.child;
        if (!original?.pid) {
          throw new Error("Fixture Gateway process unavailable before kill");
        }
        const closed = once(original, "close");
        expect(original.kill("SIGKILL")).toBe(true);
        expect(await closed).toEqual([null, "SIGKILL"]);
        await instance.stopGateway();
        parentGate.release("PARENT_CHECKPOINT_COMPLETE");
        logLiveProgress("recovered parent: waiting for restored parent to spawn and complete");
        await instance.startGateway();
        client = await connect();
        await vi.waitFor(
          async () => {
            expect(await history(parentKey)).toContain(parentFinal);
            expect(childGate.snapshot().waiting).toBeGreaterThan(0);
            const { sessions } = await client!.request<SessionsListResult>("sessions.list", {
              agentId: "main",
            });
            expect(sessions.find((session) => session.key === parentKey)).toMatchObject({
              status: "done",
              hasActiveRun: false,
            });
          },
          { timeout: 180_000 },
        );
        const children = [...loadSubagentRegistryFromSqlite().values()].filter(
          (run) => run.requesterSessionKey === parentKey,
        );
        expect(children).toHaveLength(1);
        const child = children[0]!;
        logLiveProgress("recovered parent: parent finished; releasing child effect");
        childGate.release(childFinal);
        await vi.waitFor(
          async () => {
            expect(await history(child.childSessionKey)).toContain(childFinal);
            expect(loadSubagentRegistryFromSqlite().get(child.runId)).toMatchObject({
              execution: { status: "terminal", outcome: { status: "ok" } },
            });
          },
          { timeout: 180_000 },
        );
        expect(childGate.snapshot().requests).toBe(1);
        expect(instance.logs()).not.toContain("Subagent recovery completion owner changed");
        expect(instance.logs()).not.toContain("Restart recovery admission is no longer current");
        succeeded = true;
      },
      () => {
        if (!succeeded) {
          logLiveProgress(redactSecrets(instance.logs()));
        }
      },
      () => gates.close(),
      () => client?.stopAndWait(),
      () => instance.cleanup(),
    );
  },
);
