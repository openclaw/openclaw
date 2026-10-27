import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, type TestContext } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import {
  finalizeManagedChild,
  loadManagedChildSpawner,
} from "../../scripts/lib/managed-child-process.mts";
import type { GatewayClient } from "../../src/gateway/client.js";
import { extractFirstTextBlock } from "../../src/shared/chat-message-content.js";
import type { CapturedAgentEvent } from "./gateway-codex-harness.js";

type NativeSubagentProbeParams = {
  annotate: TestContext["annotate"];
  client: GatewayClient;
  events: EventFrame[];
  sessionKey: string;
};

type GatewaySession = Pick<NativeSubagentProbeParams, "client" | "sessionKey">;

type NativeSubagentProbeHarness = {
  requestTimeoutMs: number;
  observedCodexThreadIds: ReadonlyMap<string, string>;
  /** Read the exact probe-owned native home; never enable user-home tools or adopt its children. */
  readNativeThread: (threadId: string) => Promise<unknown>;
  logCodexLiveStep: (step: string, details?: Record<string, unknown>) => void;
  requestAgentTextWithEvents: (
    params: GatewaySession & {
      acceptYieldedTimeout?: boolean;
      eventPrefix?: string;
      includeAllSessions?: boolean;
      message: string;
    },
  ) => Promise<{ runId: string; text: string; events: CapturedAgentEvent[] }>;
  recordCodexAttemptIdentity: (params: {
    events: CapturedAgentEvent[];
    runId: string;
    sessionKey: string;
  }) => void;
  requestCodexCommandText: (
    params: GatewaySession & { command: string; events: EventFrame[]; expectedText: string },
  ) => Promise<string>;
  requestAgentText: (
    params: GatewaySession & { expectedReply: string; message: string },
  ) => Promise<string>;
};

/**
 * Read the probe's persisted native history through Codex's own stdio API. The
 * Gateway owns a separate process, so its in-memory plugin client is not a test
 * surface. Never resume a thread here: the Gateway remains its sole writer.
 */
export async function withCodexNativeThreadReader(
  params: {
    command: string;
    args: string[];
    codexHome: string;
    stateDir: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    requestTimeoutMs: number;
  },
  run: (readNativeThread: NativeSubagentProbeHarness["readNativeThread"]) => Promise<void>,
): Promise<void> {
  // Fail closed before spawning if this is not the existing probe-owned home.
  const [codexHome, stateDir] = await Promise.all([
    fs.realpath(params.codexHome),
    fs.realpath(params.stateDir),
  ]);
  const relativeHome = path.relative(stateDir, codexHome);
  if (!relativeHome || relativeHome.startsWith("..") || path.isAbsolute(relativeHome)) {
    throw new Error("Native history reader requires the probe-owned Codex home.");
  }
  const spawn = await loadManagedChildSpawner();
  const child = spawn(params.command, params.args, {
    cwd: params.cwd,
    // No login or model request: read the same native store without borrowing auth.
    env: {
      ...params.env,
      CODEX_HOME: codexHome,
      CODEX_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    for (const request of pending.values()) {
      request.reject(failure);
    }
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code, signal) => {
    fail(
      new Error(`Native history reader exited (code=${String(code)}, signal=${String(signal)}).`),
    );
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    await finalizeManagedChild(child, "SIGTERM", {
      platform: process.platform,
      runTaskkill: spawnSync,
    });
    throw new Error("Native history reader requires piped stdio.");
  }
  const { stdin, stdout, stderr } = child;
  stdin.on("error", fail);
  stdout.on("error", fail);
  stderr.on("error", fail);
  stderr.resume();
  const lines = createInterface({ input: stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    try {
      const message = asOptionalRecord(JSON.parse(line));
      if (!message || typeof message.id !== "string") {
        return; // Native notifications have no request ID.
      }
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      pending.delete(message.id);
      const error = asOptionalRecord(message.error);
      if (error) {
        request.reject(new Error(`Native history request failed: ${JSON.stringify(error)}`));
      } else if (Object.hasOwn(message, "result")) {
        request.resolve(message.result);
      } else {
        request.reject(new Error("Native history response omitted its result."));
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const request = (method: "initialize" | "thread/read", args: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Native history request timed out: ${method}`));
      }, params.requestTimeoutMs);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      stdin.write(JSON.stringify({ id, method, params: args }) + "\n", (error) => {
        if (error) {
          fail(error);
        }
      });
    });
  try {
    const initialized = asOptionalRecord(
      await request("initialize", {
        clientInfo: { name: "openclaw-native-history-probe", version: "1" },
        capabilities: { experimentalApi: true },
      }),
    );
    if (
      typeof initialized?.codexHome !== "string" ||
      (await fs.realpath(initialized.codexHome)) !== codexHome
    ) {
      throw new Error("Native history reader initialized in a different Codex home.");
    }
    stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    await run((threadId) => request("thread/read", { threadId, includeTurns: true }));
    if (failure) {
      throw failure;
    }
  } finally {
    fail(new Error("Native history reader closed."));
    try {
      await finalizeManagedChild(child, "SIGTERM", {
        platform: process.platform,
        runTaskkill: spawnSync,
      });
    } finally {
      lines.close();
    }
  }
}

export async function verifyCodexNativeSubagentBridgeProbe(
  params: NativeSubagentProbeParams,
  {
    requestTimeoutMs: CODEX_HARNESS_REQUEST_TIMEOUT_MS,
    observedCodexThreadIds,
    readNativeThread: readNativeThreadFromHarness,
    logCodexLiveStep,
    requestAgentTextWithEvents,
    recordCodexAttemptIdentity,
    requestCodexCommandText,
    requestAgentText,
  }: NativeSubagentProbeHarness,
): Promise<void> {
  const runId = randomUUID();
  const childToken = `CODEX-NATIVE-CHILD-${runId.slice(0, 6).toUpperCase()}`;
  const parentToken = `CODEX-NATIVE-PARENT-${runId.slice(0, 6).toUpperCase()}`;
  const {
    text: initialReply,
    events,
    runId: parentRunId,
  } = await requestAgentTextWithEvents({
    // Native Codex waiting pauses this parent turn; native completion delivery resumes it separately.
    acceptYieldedTimeout: true,
    client: params.client,
    eventPrefix: "codex_app_server.",
    includeAllSessions: true,
    sessionKey: params.sessionKey,
    message: [
      "Bridge probe.",
      "You must use the Codex native spawn_agent tool exactly once before replying.",
      `Give the subagent this exact instruction: Reply exactly ${childToken} and nothing else.`,
      "Wait for the subagent result. Do not answer from your own knowledge.",
      `After the subagent result returns, reply exactly ${parentToken} ${childToken} and nothing else.`,
    ].join("\n"),
  });
  logCodexLiveStep("native-subagent-bridge-probe:initial-reply", { text: initialReply });
  recordCodexAttemptIdentity({
    events,
    runId: parentRunId,
    sessionKey: params.sessionKey,
  });
  expect(
    events.some((event) => event.stream === "codex_app_server.lifecycle"),
    `expected Codex lifecycle events; events=${JSON.stringify(events)}`,
  ).toBe(true);
  const parentThreadId = observedCodexThreadIds.get(params.sessionKey);
  expect(parentThreadId).toBeTypeOf("string");
  if (!parentThreadId) {
    throw new Error("Native parent thread was not observed.");
  }
  let parentItems: Record<string, unknown>[] = [];
  let childIds = new Set<string>();
  // A second native reader sees committed history, not the writer's live cache.
  await expect
    .poll(
      async () => {
        const parent = await readNativeThread(parentThreadId);
        parentItems = threadTurns(parent).flatMap(turnItems);
        childIds = spawnedChildIds(parentItems);
        return childIds.size;
      },
      { timeout: CODEX_HARNESS_REQUEST_TIMEOUT_MS, interval: 1_000 },
    )
    .toBe(1);
  const childThreadId = [...childIds][0]!;
  const assignments: Array<{ turnId: string; result: string; turn: Record<string, unknown> }> = [];
  await observeAssignment(childToken);
  const parentReplies = [`${parentToken} ${childToken}`];
  await assertParentReplies();
  await params.annotate("native-subagent-initial-thread", {
    body: JSON.stringify({ parentThreadId, childThreadId, turnId: assignments[0]!.turnId }),
    bodyEncoding: "utf-8",
    contentType: "application/json",
  });
  for (const [ordinal, prefix] of [
    ["SECOND", "FOLLOWUP"],
    ["THIRD", "THIRD"],
  ] as const) {
    const followupToken = `CODEX-NATIVE-${prefix}-${runId.slice(0, 6).toUpperCase()}`;
    const followupParentToken = `CODEX-NATIVE-PARENT-${prefix}-${runId.slice(0, 6).toUpperCase()}`;
    // Each Gateway request owns a fresh parent registration after the prior turn ended.
    const followup = await requestAgentTextWithEvents({
      client: params.client,
      eventPrefix: "codex_app_server.",
      includeAllSessions: true,
      sessionKey: params.sessionKey,
      message: [
        `Give the existing native child ${childThreadId} another assignment. Do not spawn a new child.`,
        "Use native followup_task, or send_input if that is the available native follow-up tool.",
        `Tell that child: Run the native exec_command tool with command printf ${ordinal}_NATIVE_SHELL, then reply exactly ${followupToken} and nothing else.`,
        "Wait for its new result before replying. Do not answer from your own knowledge. Keep the child open for another follow-up.",
        `After the new child result returns, reply exactly ${followupParentToken} ${followupToken} and nothing else.`,
      ].join("\n"),
    });
    recordCodexAttemptIdentity({
      events: followup.events,
      runId: followup.runId,
      sessionKey: params.sessionKey,
    });
    expect(followup.text.trim()).toBe(`${followupParentToken} ${followupToken}`);
    expect(observedCodexThreadIds.get(params.sessionKey)).toBe(parentThreadId);
    const thread = await observeAssignment(followupToken);
    const turns = threadTurns(thread);
    for (const assignment of assignments) {
      expect(turns.find((turn) => turn.id === assignment.turnId)).toEqual(assignment.turn);
    }
    // The command output must belong to this assignment, not merely appear
    // somewhere in the reused child's history. Prior turn snapshots remain unchanged above.
    expect(turnItems(assignments.at(-1)!.turn)).toContainEqual(
      expect.objectContaining({
        type: "commandExecution",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: `${ordinal}_NATIVE_SHELL`,
      }),
    );
    parentReplies.push(`${followupParentToken} ${followupToken}`);
    await assertParentReplies();
    const parent = await readNativeThread(parentThreadId);
    expect([...spawnedChildIds(threadTurns(parent).flatMap(turnItems))]).toEqual([childThreadId]);
    logCodexLiveStep("native-subagent-followup:complete", {
      childThreadId,
      assignmentCount: assignments.length,
      nativeTurnId: assignments.at(-1)!.turnId,
      parentReply: followup.text,
    });
  }

  // Native parent history, not a model-provided ID or a possibly dropped event,
  // selects the child for the ownership probe. A legacy child cannot prove this
  // V2 contract; fail explicitly rather than report an unexercised rejection as green.
  expect(
    parentItems.some(
      (item) =>
        item.type === "subAgentActivity" &&
        item.kind === "started" &&
        item.agentThreadId === childThreadId,
    ),
    "Native child-takeover proof requires a parent-controlled V2 child; the live fixture produced a legacy child.",
  ).toBe(true);
  await requestCodexCommandText({
    ...params,
    command: `/codex resume ${childThreadId}`,
    expectedText: "controlled by its parent",
  });
  await requestAgentText({
    client: params.client,
    sessionKey: params.sessionKey,
    message: "Reply exactly PARENT-STILL-ATTACHED and nothing else.",
    expectedReply: "PARENT-STILL-ATTACHED",
  });
  expect(observedCodexThreadIds.get(params.sessionKey)).toBe(parentThreadId);
  const retainedChild = await readNativeThread(childThreadId);
  for (const assignment of assignments) {
    expect(threadTurns(retainedChild).find((turn) => turn.id === assignment.turnId)).toEqual(
      assignment.turn,
    );
  }
  await assertParentReplies();
  logCodexLiveStep("native-subagent-direct-input:rejected", { childThreadId });

  async function assertParentReplies(): Promise<void> {
    await expect
      .poll(
        async () => {
          const history = await params.client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey: params.sessionKey,
            limit: 100,
          });
          // The prompt contains the expected tokens too: only exact assistant replies
          // prove delivery, and every old result must remain after each follow-up.
          return history.messages.flatMap((message) => {
            if (asOptionalRecord(message)?.role !== "assistant") {
              return [];
            }
            const text = extractFirstTextBlock(message)?.trim();
            return text ? [text] : [];
          });
        },
        { timeout: CODEX_HARNESS_REQUEST_TIMEOUT_MS, interval: 1_000 },
      )
      .toEqual(expect.arrayContaining(parentReplies));
  }

  async function readNativeThread(threadId: string): Promise<Record<string, unknown>> {
    const response = asOptionalRecord(await readNativeThreadFromHarness(threadId));
    const thread = asOptionalRecord(response?.thread);
    if (!thread || thread.id !== threadId) {
      throw new Error("Native read omitted the requested thread.");
    }
    return thread;
  }

  function spawnedChildIds(items: Record<string, unknown>[]): Set<string> {
    return new Set(
      items.flatMap((item) => {
        if (
          item.type === "subAgentActivity" &&
          item.kind === "started" &&
          typeof item.agentThreadId === "string"
        ) {
          return [item.agentThreadId];
        }
        if (
          item.type === "collabAgentToolCall" &&
          item.tool === "spawnAgent" &&
          Array.isArray(item.receiverThreadIds)
        ) {
          return item.receiverThreadIds.filter((id): id is string => typeof id === "string");
        }
        return [];
      }),
    );
  }

  function threadTurns(thread: Record<string, unknown>): Record<string, unknown>[] {
    if (!Array.isArray(thread.turns)) {
      throw new Error("Native read omitted turn history.");
    }
    return thread.turns.flatMap((turn) => {
      const record = asOptionalRecord(turn);
      return record ? [record] : [];
    });
  }

  function turnItems(turn: Record<string, unknown>): Record<string, unknown>[] {
    return Array.isArray(turn.items)
      ? turn.items.flatMap((item) => {
          const record = asOptionalRecord(item);
          return record ? [record] : [];
        })
      : [];
  }

  async function observeAssignment(result: string): Promise<Record<string, unknown>> {
    let thread: Record<string, unknown> | undefined;
    let matched: Record<string, unknown> | undefined;
    await expect
      .poll(
        async () => {
          thread = await readNativeThread(childThreadId);
          expect(thread.parentThreadId, "Native child lineage must match this probe's parent").toBe(
            parentThreadId,
          );
          matched = threadTurns(thread).find(
            (turn) =>
              turn.status === "completed" &&
              turnItems(turn).some((item) => item.type === "agentMessage" && item.text === result),
          );
          return matched?.id;
        },
        { timeout: CODEX_HARNESS_REQUEST_TIMEOUT_MS, interval: 1_000 },
      )
      .toBeTypeOf("string");
    if (!thread || !matched || typeof matched.id !== "string") {
      throw new Error("Native completion did not retain its turn identity.");
    }
    expect(assignments.map((entry) => entry.turnId)).not.toContain(matched.id);
    for (const previous of assignments) {
      expect(turnItems(matched)).not.toContainEqual(
        expect.objectContaining({ type: "agentMessage", text: previous.result }),
      );
    }
    assignments.push({ turnId: matched.id, result, turn: structuredClone(matched) });
    return thread;
  }
}
