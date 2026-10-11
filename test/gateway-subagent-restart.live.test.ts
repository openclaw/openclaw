// Real provider and cold Gateway replacement proof for subagent recovery.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createToolCallOccurrenceQueue } from "../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { inspectManagedProcessGroup } from "../scripts/lib/managed-child-process.mts";
import { isLiveTestEnabled, logLiveProgress } from "../src/agents/live-test-helpers.js";
import { createExternalGates } from "../src/agents/subagents/announce/subagent-external-gate.test-support.js";
import { loadSubagentRegistryFromSqlite } from "../src/agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import type { SubagentRunRecord } from "../src/agents/subagents/registry/subagent-registry.types.js";
import {
  prepareToolSearchDispatcherArguments,
  readToolSearchCallArgs,
} from "../src/agents/tool-search-request.js";
import type { OpenClawConfig } from "../src/config/config.js";
import { resolveSessionStorePathCore } from "../src/config/sessions.js";
import {
  loadExactSessionEntry,
  loadTranscriptEvents,
} from "../src/config/sessions/session-accessor.js";
import type { GatewayClient } from "../src/gateway/client.js";
import type { SessionsListResult } from "../src/gateway/session-utils.types.js";
import { redactSecrets } from "../src/logging/redact.js";
import {
  extractAssistantPhaseText,
  extractFirstTextBlock,
} from "../src/shared/chat-message-content.js";
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

function workerRequests(
  requests: readonly string[],
  startAt: number,
  matchesInput: (text: string) => boolean,
) {
  return requests.slice(startAt).flatMap((body, index) => {
    const request = asOptionalRecord(JSON.parse(body));
    if (!request || !Array.isArray(request.input)) {
      return [];
    }
    const matches = request.input.some((item) => {
      const message = asOptionalRecord(item);
      return (
        message?.role === "user" &&
        Array.isArray(message.content) &&
        message.content.some((block) => {
          const text = asOptionalRecord(block)?.text;
          return typeof text === "string" && matchesInput(text);
        })
      );
    });
    return matches ? [{ index: startAt + index, request }] : [];
  });
}

function inspectToolHistory(messages: readonly Record<string, unknown>[]) {
  const calls = createToolCallOccurrenceQueue<{
    args: Record<string, unknown>;
    callIndex: number;
  }>();
  const exchanges: Array<{
    name: string;
    args: Record<string, unknown>;
    callIndex: number;
    resultIndex: number;
    result: Record<string, unknown>;
    isError: boolean;
  }> = [];
  const commandCalls: Record<string, unknown>[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const value of message.content) {
        const block = asOptionalRecord(value);
        if (block?.type !== "toolCall") {
          continue;
        }
        const selectors =
          block.name === "tool_call"
            ? asOptionalRecord(prepareToolSearchDispatcherArguments(block.arguments))
            : undefined;
        if (
          block.name === "exec" ||
          block.name === "process" ||
          ["id", "toolId", "name"].some((key) => {
            const selector = selectors?.[key];
            return (
              typeof selector === "string" &&
              ["exec", "process", "openclaw:core:exec", "openclaw:core:process"].includes(
                selector.trim(),
              )
            );
          })
        ) {
          commandCalls.push(block);
        }
        const args = asOptionalRecord(block?.arguments);
        if (typeof block.id !== "string" || !args) {
          continue;
        }
        calls.add(block.id, { args, callIndex: index });
      }
    }
    if (message.role !== "toolResult" || typeof message.toolCallId !== "string") {
      continue;
    }
    const call = calls.claim(message.toolCallId);
    if (!call) {
      continue;
    }
    const persistedDetails = asOptionalRecord(message.details);
    // Diagnostic metadata is capped independently of the model-visible receipt.
    const details =
      persistedDetails?.persistedDetailsTruncated === true
        ? asOptionalRecord(JSON.parse(extractFirstTextBlock(message) ?? "null"))
        : persistedDetails;
    const wrapped = message.toolName === "tool_call";
    const name = wrapped ? asOptionalRecord(details?.tool)?.name : message.toolName;
    const result = wrapped ? asOptionalRecord(asOptionalRecord(details?.result)?.details) : details;
    if (typeof name !== "string" || !result) {
      continue;
    }
    const args = wrapped
      ? asOptionalRecord(
          readToolSearchCallArgs(prepareToolSearchDispatcherArguments(call.args)).input,
        )
      : call.args;
    if (args) {
      exchanges.push({
        name,
        args,
        callIndex: call.callIndex,
        resultIndex: index,
        result,
        isError: message.isError === true,
      });
    }
  }
  return { exchanges, commandCalls };
}

it.skipIf(!isLiveTestEnabled() || process.platform === "win32")(
  "preserves tool results through parent-owned follow-ups across two cold restarts without orphan replay",
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
    let secondRecoveryRequest: ReturnType<typeof workerRequests>[number] | undefined;
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
              modelPolicy: { allow: [modelRef] },
              models: { [modelRef]: { agentRuntime: { id: "openclaw" } } },
              thinkingDefault: "low",
              skipBootstrap: true,
              skills: [],
              timeoutSeconds: 600,
              subagents: { allowAgents: ["*"], runTimeoutSeconds: 600, announceTimeoutMs: 180_000 },
            },
            entries: { main: {} },
          },
          tools: {
            allow: [
              "sessions_spawn",
              "sessions_yield",
              "sessions_send",
              "sessions_history",
              "subagents",
              "exec",
              "process",
            ],
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
        const onlyChildFor = (parent: string) => {
          const children = [...loadSubagentRegistryFromSqlite().values()].filter(
            (run) => run.requesterSessionKey === parent,
          );
          expect(children.length).toBeLessThanOrEqual(1);
          return children[0];
        };
        const transcript = async (sessionKey: string) => {
          const scope = { agentId: "main", storePath, sessionKey };
          const entry = loadExactSessionEntry(scope)?.entry;
          if (!entry) {
            throw new Error(`Missing fixture session: ${sessionKey}`);
          }
          return (await loadTranscriptEvents({ ...scope, sessionId: entry.sessionId })).flatMap(
            (event) => {
              const message = asOptionalRecord(asOptionalRecord(event)?.message);
              return message ? [message] : [];
            },
          );
        };
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
        const followupMessage =
          "Continue the original two-command task from your retained history. The previous " +
          "execution has stopped. Preserve every successful stdout already recorded; do not " +
          "repeat its command. These fixture HTTP requests only read results, so rerun only " +
          "a command interrupted without successful stdout. Ignore old process handles. " +
          "Return the original exact two-line result when both commands have succeeded.";
        const followupFor = async (previous: SubagentRunRecord, count: number, after: number) => {
          const { exchanges, commandCalls } = inspectToolHistory(await transcript(parentKey));
          const sends = exchanges.filter((exchange) => exchange.name === "sessions_send");
          expect(sends).toHaveLength(count);
          const sent = sends[count - 1]!;
          expect(sent.callIndex).toBeGreaterThanOrEqual(after);
          expect(sent.isError).toBe(false);
          expect(sent.args).toMatchObject({
            sessionKey: previous.childSessionKey,
            mode: "followup",
            timeoutSeconds: 0,
          });
          expect(sent.result).toMatchObject({
            status: "accepted",
            runId: expect.any(String),
            sessionKey: previous.childSessionKey,
            targetDisposition: "queued",
            delivery: { status: "pending" },
          });
          const inspections = exchanges.filter(
            (exchange) => exchange.callIndex >= after && exchange.resultIndex < sent.callIndex,
          );
          const stopped = inspections.find(
            (exchange) =>
              exchange.name === "subagents" &&
              exchange.args.action === "wait" &&
              exchange.args.timeoutSeconds === 0 &&
              Array.isArray(exchange.args.runIds) &&
              exchange.args.runIds.includes(previous.runId) &&
              !exchange.isError &&
              exchange.result.status === "ok" &&
              exchange.result.reason === "completed" &&
              Array.isArray(exchange.result.runs) &&
              exchange.result.runs.some((value) => {
                const run = asOptionalRecord(value);
                return run?.runId === previous.runId && run.status === "terminal";
              }),
          );
          expect(stopped?.result).toMatchObject({
            status: "ok",
            reason: "completed",
            runs: expect.arrayContaining([
              expect.objectContaining({ runId: previous.runId, status: "terminal" }),
            ]),
          });
          const inspected = inspections.find(
            (exchange) =>
              exchange.name === "sessions_history" &&
              exchange.args.sessionKey === previous.childSessionKey &&
              exchange.args.includeTools === true &&
              !exchange.isError &&
              exchange.result.sessionKey === previous.childSessionKey &&
              Array.isArray(exchange.result.messages) &&
              (count !== 2 || JSON.stringify(exchange.result.messages).includes(firstMarker)),
          );
          expect(inspected?.result).toMatchObject({
            sessionKey: previous.childSessionKey,
            messages: expect.any(Array),
          });
          if (count === 2) {
            expect(JSON.stringify(inspected?.result.messages)).toContain(firstMarker);
          }
          expect(commandCalls).toEqual([]);
          expect(
            exchanges.filter(
              (exchange) =>
                exchange.name === "sessions_yield" &&
                exchange.result.status === "yielded" &&
                !exchange.isError,
            ),
          ).toHaveLength(count + 1);
          const runs = loadSubagentRegistryFromSqlite();
          expect(
            [...runs.values()].filter(
              (run) =>
                run.requesterSessionKey === parentKey &&
                run.childSessionKey === previous.childSessionKey,
            ),
          ).toHaveLength(count + 1);
          expect(runs.get(previous.runId)).toMatchObject({
            execution: { status: "terminal", interruptionReason: "gateway-restart" },
          });
          if (typeof sent.result.runId !== "string") {
            throw new Error("Follow-up acceptance has no run ID");
          }
          const continued = runs.get(sent.result.runId);
          if (!continued) {
            throw new Error("Accepted child follow-up has no registered completion owner");
          }
          expect(continued).toMatchObject({
            childSessionKey: previous.childSessionKey,
            requesterSessionKey: parentKey,
            taskRunId: continued.runId,
            expectsCompletionMessage: true,
          });
          expect(continued.runId).not.toBe(previous.runId);
          expect(continued.generation).toBeGreaterThan(previous.generation ?? 0);
          return continued;
        };
        await instance.startGateway();
        client = await connect();
        evidence.phase = "initial-checkpoint";
        logLiveProgress("subagent restart: dispatching parent; waiting for child HTTP checkpoint");
        await start(
          parentKey,
          [
            `Call sessions_spawn exactly once with ${JSON.stringify({ taskName: "restart_worker", task: childTask, cleanup: "keep", context: "isolated" })}.`,
            "Immediately call sessions_yield after acceptance. Wait for the actual child completion; never execute the child's commands yourself or spawn a replacement.",
            "If the Gateway interrupts a child, call subagents with action wait, runIds containing that interrupted run ID, and timeoutSeconds 0. Continue only after it confirms the old run is terminal.",
            "Then inspect that same child's saved history with sessions_history, includeTools true. Reconcile successful stdout and the interrupted read-only HTTP command before continuing.",
            `After those checks call sessions_send on that same retained child session with mode followup, timeoutSeconds 0, and a message following this guidance: ${JSON.stringify(followupMessage)}.`,
            "Immediately call sessions_yield after accepted follow-up. Repeat these inspection and follow-up steps if another Gateway restart interrupts it. Never repeat a send whose acceptance is uncertain.",
            `Your only final reply must be ${finalMarker} followed by the child's exact two-line result.`,
          ].join("\n"),
        );
        const initial = await vi.waitUntil(
          async () => {
            const child = onlyChildFor(parentKey);
            if (child?.execution.status === "terminal") {
              throw new Error(
                `Child ended before the initial HTTP checkpoint: ${JSON.stringify(child.execution.outcome)}`,
              );
            }
            return first.snapshot().waiting > 0 &&
              child?.requesterSettleWake?.requesterYieldBatch === true &&
              inspectToolHistory(await transcript(parentKey)).exchanges.some(
                (exchange) =>
                  exchange.name === "sessions_yield" &&
                  exchange.result.status === "yielded" &&
                  !exchange.isError,
              )
              ? child
              : undefined;
          },
          { timeout: WAIT_MS },
        );
        expect(initial.runId).toBeTruthy();
        const childSessionId = loadExactSessionEntry({
          agentId: "main",
          storePath,
          sessionKey: initial.childSessionKey,
        })!.entry.sessionId;
        const parentBeforeFirstRestart = (await transcript(parentKey)).length;
        const initialPid = await killOwnedGateway();
        first.release(firstMarker);
        evidence.phase = "first-recovery-checkpoint";
        logLiveProgress("subagent restart: initial child interrupted; starting recovery 1");
        await instance.startGateway();
        client = await connect();
        await vi.waitFor(
          async () => {
            expect(second.snapshot().waiting).toBeGreaterThan(0);
            const recovered = await followupFor(initial, 1, parentBeforeFirstRestart);
            expect(recovered.requesterSettleWake).toMatchObject({
              requesterYieldBatch: true,
              batchRunIds: [recovered.runId],
            });
            expect(
              loadExactSessionEntry({
                agentId: "main",
                storePath,
                sessionKey: initial.childSessionKey,
              })?.entry,
            ).toMatchObject({ sessionId: childSessionId, lifecycleRunId: recovered.runId });
            expect(JSON.stringify(await transcript(initial.childSessionKey))).toContain(
              firstMarker,
            );
          },
          { timeout: WAIT_MS },
        );
        const recovered = await followupFor(initial, 1, parentBeforeFirstRestart);
        const firstRequests = first.snapshot().requests;
        expect(firstRequests).toBe(2);
        const parentBeforeSecondRestart = (await transcript(parentKey)).length;
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
            workerRequests(
              provider!.requests,
              providerBeforeSecondRestart,
              (text) =>
                text.includes(`sourceSession=${parentKey} `) &&
                text.includes("sourceTool=sessions_send "),
            )[0],
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
            const completed = await followupFor(recovered, 2, parentBeforeSecondRestart);
            expect(completed).toMatchObject({
              execution: { outcome: { status: "ok" } },
              delivery: { status: "delivered" },
            });
            expect(completed.requesterSettleWake).toBeUndefined();
          },
          { timeout: WAIT_MS },
        );
        const completed = await followupFor(recovered, 2, parentBeforeSecondRestart);
        expect((await history(parentKey)).filter((text) => text === expectedFinal)).toHaveLength(1);
        const finalDeliveries = (await transcript(parentKey)).filter((message) => {
          const provenance = asOptionalRecord(message.provenance);
          return (
            message.role === "user" &&
            provenance?.sourceTool === "subagent_settle" &&
            provenance.sourceSessionKey === initial.childSessionKey &&
            JSON.stringify(message.content).includes(firstMarker) &&
            JSON.stringify(message.content).includes(secondMarker)
          );
        });
        expect(finalDeliveries).toHaveLength(1);
        expect(first.snapshot().requests).toBe(firstRequests);
        expect(second.snapshot().requests).toBe(2);
        Object.assign(evidence, {
          initialPid,
          recoveredPid,
          finalPid: instance.child?.pid,
          childSessionKey: initial.childSessionKey,
          executionRunIds: [initial.runId, recovered.runId, completed.runId],
          recoveredMarkerReachedProvider: true,
          successfulFirstCommandRepeated: false,
          successfulSecondCommandRepeated: false,
          parentFinalCount: 1,
        });

        const orphanParent = `agent:main:orphan-parent-${randomUUID()}`;
        const orphanGate = gates.create();
        const orphanParentFinal = `ORPHAN_CHILD_SPAWNED_${randomUUID()}`;
        evidence.phase = "orphan-child-checkpoint";
        await start(
          orphanParent,
          [
            `Call sessions_spawn exactly once with ${JSON.stringify({ taskName: "orphan_worker", task: `Run ${fetchCommand(orphanGate.url)} with exec, timeoutSeconds 300, then use process to wait and reply with stdout. Do not spawn or write files.`, cleanup: "keep", context: "isolated", expectsCompletionMessage: false })}.`,
            `After acceptance reply exactly ${orphanParentFinal}. Do not yield or wait; this child sends no completion notification.`,
          ].join("\n"),
        );
        await vi.waitFor(
          async () => {
            expect(orphanGate.snapshot().waiting).toBeGreaterThan(0);
            expect(await history(orphanParent)).toContain(orphanParentFinal);
            await expectSessionDone(orphanParent);
          },
          { timeout: WAIT_MS },
        );
        const orphan = onlyChildFor(orphanParent)!;
        expect(orphan.expectsCompletionMessage).toBe(false);
        await killOwnedGateway();
        const providerBeforeOrphanRestart = provider.requests.length;
        const orphanGateRequests = orphanGate.snapshot().requests;
        evidence.providerBeforeOrphanRestart = providerBeforeOrphanRestart;
        orphanGate.release("ORPHAN_GATE_RELEASED");
        evidence.phase = "orphan-child-restart";
        logLiveProgress(
          "subagent restart: nonannouncing orphan interrupted; verifying parent handoff",
        );
        await instance.startGateway();
        client = await connect();
        const settledOrphan = await vi.waitFor(
          () => {
            const settled = onlyChildFor(orphanParent);
            expect(settled).toMatchObject({
              runId: orphan.runId,
              terminalOwner: "interrupted-recovery",
              cleanupCompletedAt: expect.any(Number),
              execution: {
                status: "terminal",
                interruptionReason: "gateway-restart",
              },
            });
            return settled!;
          },
          { timeout: 30_000 },
        );
        const orphanProviderDispatches = workerRequests(
          provider.requests,
          providerBeforeOrphanRestart,
          (text) => text.includes("[Subagent Task]") && text.includes(orphanGate.url),
        ).length;
        await vi.waitFor(
          () =>
            expect(
              workerRequests(
                provider!.requests,
                providerBeforeOrphanRestart,
                (text) =>
                  text.includes("Reconcile every listed unfinished child") &&
                  text.includes(orphan.childSessionKey),
              ).length,
            ).toBeGreaterThan(0),
          { timeout: WAIT_MS },
        );
        Object.assign(evidence, {
          phase: "passed",
          orphanRunId: orphan.runId,
          orphanCleanupCompletedAt: settledOrphan.cleanupCompletedAt,
          orphanProviderDispatches,
          orphanGateRequestsBeforeRestart: orphanGateRequests,
          orphanParentContinuationObserved: true,
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
        const sessionKeys = new Set([...parents, ...runs.map((run) => run.childSessionKey)]);
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
