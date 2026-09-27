// Real provider and cold Gateway replacement proof for subagent recovery.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import type { TaskSummary } from "../packages/gateway-protocol/src/schema/tasks.js";
import { inspectManagedProcessGroup } from "../scripts/lib/managed-child-process.mts";
import { isLiveTestEnabled, logLiveProgress } from "../src/agents/live-test-helpers.js";
import { createExternalGates } from "../src/agents/subagents/announce/subagent-external-gate.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryChangesToSqlite,
} from "../src/agents/subagents/registry/subagent-registry.store.sqlite.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { resolveSessionStorePathCore } from "../src/config/sessions.js";
import {
  loadExactSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
} from "../src/config/sessions/session-accessor.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { redactSecrets } from "../src/logging/redact.js";
import { extractAssistantPhaseText } from "../src/shared/chat-message-content.js";
import { cleanupSessionStateForTest } from "../src/test-utils/session-state-cleanup.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import { acquireGatewayTestClient } from "./helpers/gateway-client.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const WAIT_MS = 180_000;

async function observeOpenAiResponses() {
  const requests: string[] = [];
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    const controller = new AbortController();
    response.on("close", () => controller.abort());
    const operation = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString("utf8");
        requests.push(body);
        const upstream = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            authorization: request.headers.authorization ?? "",
            "content-type": "application/json",
          },
          body,
          signal: controller.signal,
        });
        response.writeHead(upstream.status, {
          "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        });
        if (upstream.body) {
          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            response.write(value);
          }
        }
        response.end();
      } catch (error) {
        if (!controller.signal.aborted) {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        }
      }
    })();
    pending.add(operation);
    void operation.then(() => pending.delete(operation));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("OpenAI observation listener has no TCP address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      server.closeAllConnections();
      await Promise.all([closed, ...pending]);
    },
  };
}

function fetchCommand(url: string): string {
  const script = `const r = await fetch(${JSON.stringify(url)}); const text = await r.text(); if (!r.ok) throw new Error(text); console.log(text);`;
  return [process.execPath, "--input-type=module", "-e", script]
    .map((value) => `'${value.replaceAll("'", "'\\''")}'`)
    .join(" ");
}

function recoveredWorkerRequests(requests: readonly string[], parentKey: string, startAt: number) {
  return requests.slice(startAt).flatMap((body, index) => {
    const request = asOptionalRecord(JSON.parse(body));
    if (
      !request ||
      !Array.isArray(request.input) ||
      !Array.isArray(request.tools) ||
      !request.tools.some((tool) => asOptionalRecord(tool)?.name === "exec")
    ) {
      return [];
    }
    const matches = request.input.some((item) => {
      const message = asOptionalRecord(item);
      return (
        message?.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((block) => {
          const text = asOptionalRecord(block)?.text;
          return (
            typeof text === "string" &&
            text.includes(`sourceSession=${parentKey} `) &&
            text.includes("sourceTool=subagent_interrupted_resume ")
          );
        })
      );
    });
    return matches ? [{ index: startAt + index, request }] : [];
  });
}

it.skipIf(!isLiveTestEnabled() || process.platform === "win32")(
  "preserves recovered tool results across two cold restarts and refuses stale hard-kill replay",
  { timeout: 900_000 },
  async () => {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("Subagent restart live proof requires OPENAI_API_KEY");
    }
    const modelRef = process.env.OPENCLAW_LIVE_SUBAGENT_E2E_MODEL?.trim() || "openai/gpt-5.6-sol";
    expect(modelRef.startsWith("openai/")).toBe(true);
    const model = modelRef.slice("openai/".length);
    const instance = await createOpenClawTestInstance({
      name: "subagent-cold-restart-live",
      env: {
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: undefined,
        OPENAI_API_BASE: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
      startTimeoutMs: 120_000,
      stopTimeoutMs: 10_000,
    });
    let client: GatewayClient | undefined;
    let provider: Awaited<ReturnType<typeof observeOpenAiResponses>> | undefined;
    let secondRecoveryRequest: ReturnType<typeof recoveredWorkerRequests>[number] | undefined;
    let gates: Awaited<ReturnType<typeof createExternalGates>> | undefined;
    const parents = new Set<string>();
    let fixtureStateBound = false;
    const artifactDir = path.resolve(
      process.env.OPENCLAW_LIVE_SUBAGENT_EVIDENCE_DIR || ".artifacts/qa-e2e",
      `subagent-cold-restart-${randomUUID()}`,
    );
    const evidence: Record<string, unknown> = { model: modelRef };
    await runQaGatewayFixture(
      async () => {
        await mkdir(artifactDir, { recursive: true });
        provider = await observeOpenAiResponses();
        gates = await createExternalGates();
        const cfg: OpenClawConfig = {
          secrets: { providers: { default: { source: "env" } } },
          models: {
            mode: "replace",
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: provider.baseUrl,
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
                models: [
                  {
                    id: model,
                    name: model,
                    reasoning: true,
                    input: ["text"],
                    contextWindow: 128_000,
                    maxTokens: 8_192,
                    // The recorder forwards to OpenAI, which accepts the strict tool field.
                    compat: { supportsStrictMode: true },
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
          plugins: { enabled: false },
          agents: {
            defaults: {
              workspace: instance.state.workspaceDir,
              model: { primary: modelRef },
              models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
              thinkingDefault: "low",
              heartbeat: { every: "0m" },
              skipBootstrap: true,
              skills: [],
              timeoutSeconds: 600,
              subagents: { allowAgents: ["*"], runTimeoutSeconds: 600, announceTimeoutMs: 180_000 },
            },
            entries: { main: { default: true } },
          },
          tools: {
            allow: ["sessions_spawn", "sessions_yield", "exec", "process"],
            exec: { mode: "full", host: "gateway" },
            codeMode: { enabled: false },
          },
          gateway: {
            mode: "local",
            bind: "loopback",
            port: instance.port,
            auth: { mode: "token", token: instance.gatewayToken },
            controlUi: { enabled: false },
          },
        };
        await instance.state.writeConfig(cfg);
        instance.state.applyEnv();
        fixtureStateBound = true;
        const storePath = resolveSessionStorePathCore(undefined, {
          agentId: "main",
          env: instance.env,
        });
        const connect = () =>
          acquireGatewayTestClient(
            {
              url: instance.url,
              token: instance.gatewayToken,
              deviceIdentity: null,
              clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
              mode: GATEWAY_CLIENT_MODES.BACKEND,
              scopes: ["operator.admin", "operator.read", "operator.write"],
              requestTimeoutMs: WAIT_MS,
            },
            {
              timeoutMs: 60_000,
              timeoutMessage: "Subagent restart Gateway connect timeout",
              closeMessage: "Subagent restart Gateway closed during connect",
            },
          );
        const killOwnedGateway = async () => {
          await client?.stopAndWait();
          client = undefined;
          const processOwner = instance.child;
          if (!processOwner?.pid) {
            throw new Error("Owned subagent Gateway process is unavailable");
          }
          process.kill(-processOwner.pid, "SIGKILL");
          await vi.waitFor(
            () =>
              expect(
                inspectManagedProcessGroup(processOwner, { errorPolicy: "indeterminate" }),
              ).toBe("dead"),
            { timeout: 10_000 },
          );
          await instance.stopGateway();
          return processOwner.pid;
        };
        const childFor = (parent: string) =>
          [...loadSubagentRegistryFromSqlite().values()].find(
            (run) => run.requesterSessionKey === parent,
          );
        const history = async (sessionKey: string) => {
          const result = await client!.request<{
            messages: Array<{ role: string; content?: unknown }>;
          }>("chat.history", { sessionKey });
          return result.messages
            .filter((message) => message.role === "assistant")
            .map((message) => extractAssistantPhaseText(message)?.trim());
        };
        const expectSessionDone = async (sessionKey: string) => {
          const { sessions } = await client!.request<SessionsListResult>("sessions.list", {
            agentId: "main",
          });
          expect(sessions.find((session) => session.key === sessionKey)).toMatchObject({
            status: "done",
            hasActiveRun: false,
          });
        };
        const start = (sessionKey: string, message: string) => {
          parents.add(sessionKey);
          return client!.request("agent", {
            sessionKey,
            message,
            idempotencyKey: randomUUID(),
            deliver: false,
            timeout: 600,
          });
        };

        const parentKey = `agent:main:restart-parent-${randomUUID()}`;
        const first = gates.create();
        const second = gates.create();
        const firstMarker = `First command completed successfully. Receipt: ${randomUUID()}`;
        const secondMarker = `Second command completed successfully. Receipt: ${randomUUID()}`;
        const finalMarker = `RECOVERY_PARENT_${randomUUID()}`;
        const childTask = [
          "Complete exactly two HTTP commands in order. Use only exec and process; do not write files or spawn.",
          `First command: ${fetchCommand(first.url)}`,
          `Second command: ${fetchCommand(second.url)}`,
          "Use yieldMs 1000 and timeoutSeconds 300. Poll a pending process until it finishes. Never repeat a command that already returned successful stdout.",
          "Only poll when exec explicitly returns a running process session ID. Completed stdout is the command result, not a process handle.",
          "Gateway restarts may interrupt a pending command. After recovery, ignore old process handles and rerun only the interrupted command. Preserve all earlier successful stdout from your transcript.",
          "After both commands succeed, reply with exactly the first command's stdout on the first line and the second command's stdout on the second line. No other content.",
        ].join("\n");
        await instance.startGateway();
        client = await connect();
        evidence.phase = "initial-checkpoint";
        logLiveProgress("subagent restart: dispatching parent; waiting for child HTTP checkpoint");
        await start(
          parentKey,
          [
            `Call sessions_spawn exactly once with ${JSON.stringify({ taskName: "restart_worker", task: childTask, cleanup: "keep", context: "isolated" })}.`,
            "Immediately call sessions_yield after acceptance. Do not call other tools; wait for the actual child completion.",
            `Your only final reply must be ${finalMarker} followed by the child's exact two-line result.`,
          ].join("\n"),
        );
        const initial = await vi.waitUntil(
          () => {
            const child = childFor(parentKey);
            if (child?.execution.status === "terminal") {
              throw new Error(
                `Child ended before the initial HTTP checkpoint: ${JSON.stringify(child.execution.outcome)}`,
              );
            }
            return first.snapshot().waiting > 0 &&
              child?.requesterSettleWake?.requesterYieldBatch === true
              ? child
              : undefined;
          },
          { timeout: WAIT_MS },
        );
        const tasksBefore = await client.request<{ tasks: TaskSummary[] }>("tasks.list", {
          sessionKey: parentKey,
          limit: 100,
        });
        const originalTask = tasksBefore.tasks.find(
          (task) => task.runtime === "subagent" && task.childSessionKey === initial.childSessionKey,
        )!;
        expect(originalTask?.id).toBeTruthy();
        const initialPid = await killOwnedGateway();
        first.release(firstMarker);
        evidence.phase = "first-recovery-checkpoint";
        logLiveProgress("subagent restart: initial child interrupted; starting recovery 1");
        await instance.startGateway();
        client = await connect();
        await vi.waitFor(
          async () => {
            expect(second.snapshot().waiting).toBeGreaterThan(0);
            const recovered = childFor(parentKey);
            expect(recovered?.runId).not.toBe(initial.runId);
            expect(recovered?.execution.restartRecovery).toBeUndefined();
            const target = recovered?.execution.transcriptTarget;
            expect(target?.sessionId).toBeTruthy();
            expect(
              JSON.stringify(
                await loadTranscriptEvents({ ...target!, sessionId: target!.sessionId! }),
              ),
            ).toContain(firstMarker);
          },
          { timeout: WAIT_MS },
        );
        const recovered = childFor(parentKey)!;
        const firstRequests = first.snapshot().requests;
        const recoveredPid = await killOwnedGateway();
        const providerBeforeSecondRestart = provider.requests.length;
        evidence.providerBeforeSecondRestart = providerBeforeSecondRestart;
        second.release(secondMarker);
        evidence.phase = "second-recovery-final";
        logLiveProgress("subagent restart: recovered receipt persisted; starting recovery 2");
        await instance.startGateway();
        client = await connect();
        secondRecoveryRequest = await vi.waitUntil(
          () =>
            recoveredWorkerRequests(provider!.requests, parentKey, providerBeforeSecondRestart)[0],
          { timeout: WAIT_MS },
        );
        evidence.secondRecoveryRequestIndex = secondRecoveryRequest.index;
        expect(secondRecoveryRequest.request.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "function_call_output",
              output: expect.stringContaining(firstMarker),
            }),
          ]),
        );
        const expectedFinal = `${finalMarker}\n${firstMarker}\n${secondMarker}`;
        await vi.waitFor(
          async () => {
            expect(await history(parentKey)).toContain(expectedFinal);
            await expectSessionDone(parentKey);
            expect(childFor(parentKey)).toMatchObject({
              execution: { outcome: { status: "ok" } },
              delivery: { status: "delivered" },
            });
            const { tasks } = await client!.request<{ tasks: TaskSummary[] }>("tasks.list", {
              sessionKey: parentKey,
              limit: 100,
            });
            expect(tasks.find((task) => task.id === originalTask.id)).toMatchObject({
              status: "completed",
              runId: originalTask.runId,
            });
          },
          { timeout: WAIT_MS },
        );
        const completed = childFor(parentKey)!;
        expect(completed.taskRunId).toBe(initial.taskRunId ?? initial.runId);
        expect(completed.runId).not.toBe(recovered.runId);
        expect((await history(parentKey)).filter((text) => text === expectedFinal)).toHaveLength(1);
        expect(first.snapshot().requests).toBe(firstRequests);
        Object.assign(evidence, {
          initialPid,
          recoveredPid,
          finalPid: instance.child?.pid,
          taskId: originalTask.id,
          taskRunId: originalTask.runId,
          executionRunIds: [initial.runId, recovered.runId, completed.runId],
          recoveredMarkerReachedProvider: true,
          successfulFirstCommandRepeated: false,
          parentFinalCount: 1,
        });

        const staleParent = `agent:main:stale-parent-${randomUUID()}`;
        const staleGate = gates.create();
        const staleParentFinal = `STALE_CHILD_SPAWNED_${randomUUID()}`;
        evidence.phase = "stale-child-checkpoint";
        await start(
          staleParent,
          [
            `Call sessions_spawn exactly once with ${JSON.stringify({ taskName: "stale_worker", task: `Run ${fetchCommand(staleGate.url)} with exec, timeoutSeconds 300, then use process to wait and reply with stdout. Do not spawn or write files.`, cleanup: "keep", context: "isolated", expectsCompletionMessage: false })}.`,
            `After acceptance reply exactly ${staleParentFinal}. Do not yield or wait; this child sends no completion notification.`,
          ].join("\n"),
        );
        await vi.waitFor(
          async () => {
            expect(staleGate.snapshot().waiting).toBeGreaterThan(0);
            expect(await history(staleParent)).toContain(staleParentFinal);
            await expectSessionDone(staleParent);
          },
          { timeout: WAIT_MS },
        );
        const stale = childFor(staleParent)!;
        expect(stale.expectsCompletionMessage).toBe(false);
        await killOwnedGateway();
        const runs = loadSubagentRegistryFromSqlite();
        const owned = runs.get(stale.runId)!;
        const staleAt = Date.now() - 3 * 24 * 60 * 60_000;
        owned.createdAt = staleAt;
        owned.sessionStartedAt = staleAt;
        owned.execution.startedAt = staleAt;
        expect(owned.execution.status).toBe("running");
        expect(owned.execution.interruptedAt).toBeUndefined();
        saveSubagentRegistryChangesToSqlite(runs, [owned.runId]);
        const scope = { agentId: "main", storePath, sessionKey: owned.childSessionKey };
        const childEntry = loadExactSessionEntry(scope)!.entry;
        expect(childEntry.lifecycleRunId).toBe(owned.runId);
        await patchSessionEntryCore(
          scope,
          (current) => ({
            ...current,
            updatedAt: staleAt,
            startedAt: staleAt,
            abortedLastRun: false,
          }),
          {
            assertCommitAllowed: () => expect(instance.child).toBeUndefined(),
            replaceEntry: true,
          },
        );
        expect(loadExactSessionEntry(scope)!.entry.updatedAt).toBe(staleAt);
        await cleanupSessionStateForTest({ stateDir: instance.stateDir });
        const providerBeforeStaleRestart = provider.requests.length;
        const staleGateRequests = staleGate.snapshot().requests;
        evidence.providerBeforeStaleRestart = providerBeforeStaleRestart;
        staleGate.release("STALE_GATE_RELEASED");
        evidence.phase = "stale-child-restart";
        logLiveProgress("subagent restart: stopped fixture aged three days; verifying no replay");
        await instance.startGateway();
        client = await connect();
        await vi.waitFor(
          () =>
            expect(childFor(staleParent)?.execution.outcome).toMatchObject({
              status: "error",
              error: expect.stringContaining("stale aborted subagent run not resumed"),
            }),
          { timeout: 30_000 },
        );
        expect(childFor(staleParent)?.runId).toBe(owned.runId);
        const staleProviderDispatches = recoveredWorkerRequests(
          provider.requests,
          staleParent,
          providerBeforeStaleRestart,
        ).length;
        expect(staleProviderDispatches).toBe(0);
        expect(staleGate.snapshot().requests).toBe(staleGateRequests);
        Object.assign(evidence, {
          phase: "passed",
          staleRunId: owned.runId,
          staleAt,
          staleProviderDispatches,
        });
        logLiveProgress(`subagent cold restart proof passed; evidence=${artifactDir}`);
      },
      () =>
        writeFile(
          path.join(artifactDir, "provider.json"),
          JSON.stringify(
            redactSecrets({
              requestCount: provider?.requests.length ?? 0,
              secondRecoveryRequest,
              requests: provider?.requests.slice(-16).map((body) => JSON.parse(body)) ?? [],
            }),
            null,
            2,
          ),
        ),
      async () => {
        if (!fixtureStateBound) {
          return;
        }
        const runs = [...loadSubagentRegistryFromSqlite().values()].filter((run) =>
          parents.has(run.requesterSessionKey),
        );
        const sessionKeys = new Set([
          ...parents,
          ...runs.flatMap((run) =>
            [run.childSessionKey, run.execution.transcriptTarget?.sessionKey].filter(
              (key): key is string => Boolean(key),
            ),
          ),
        ]);
        const storePath = resolveSessionStorePathCore(undefined, {
          agentId: "main",
          env: instance.env,
        });
        const sessions = await Promise.all(
          [...sessionKeys].map(async (sessionKey) => {
            const scope = { agentId: "main", storePath, sessionKey };
            const entry = loadExactSessionEntry(scope)?.entry;
            return {
              sessionKey,
              entry,
              transcript: entry
                ? await loadTranscriptEvents({ ...scope, sessionId: entry.sessionId })
                : [],
            };
          }),
        );
        await writeFile(
          path.join(artifactDir, "state.json"),
          JSON.stringify(redactSecrets({ runs, sessions, gates: gates?.snapshot() }), null, 2),
        );
      },
      () => writeFile(path.join(artifactDir, "gateway.log"), redactSecrets(instance.logs())),
      () => writeFile(path.join(artifactDir, "proof.json"), JSON.stringify(evidence, null, 2)),
      () => gates?.close(),
      () => client?.stopAndWait(),
      () => instance.cleanup(),
      () => provider?.close(),
    );
  },
);
