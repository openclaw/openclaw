import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { GatewayClient } from "../../src/gateway/client.js";
import { listDirectoryTreeStrict } from "../../src/infra/directory-walk.js";
import { extractAssistantTexts, formatAssistantTextPreview } from "./gateway-codex-harness.js";

/** Gateway-local tools OpenClaw Enterprise excludes from dedicated Codex Gateways. */
export const CODEX_HARNESS_GATEWAY_LOCAL_TOOLS = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
] as const;

async function listCodexRollouts(codexHome: string): Promise<string[]> {
  const root = path.join(codexHome, "sessions");
  const entries = await listDirectoryTreeStrict(root).catch(() => []);
  return entries
    .filter((entry) => /rollout-.*\.jsonl$/u.test(entry.relativePath))
    .map((entry) => path.join(root, entry.relativePath));
}

type ProbeParams = {
  client: GatewayClient;
  sessionKey: string;
  thinking: string;
  requestTimeoutMs: number;
  agentTimeoutSeconds: number;
  log: (step: string, details?: Record<string, unknown>) => void;
};

async function spawnHiddenSubagent(
  params: ProbeParams & { task: string; sentinels: readonly string[] },
): Promise<{ childSessionKey: string; replies: string[] }> {
  // Spawn through the parent's own model turn, as a real user session does.
  // A Gateway tools.invoke spawn makes the child inherit that HTTP surface's
  // default denies (exec, apply_patch, ...), which correctly remove its shell.
  const listSubagents = async (): Promise<Set<string>> => {
    const listed: { sessions?: Array<{ key?: string }> } = await params.client.request(
      "sessions.list",
      { includeGlobal: true, limit: 200 },
    );
    return new Set(
      (listed.sessions ?? [])
        .map((entry) => entry.key)
        .filter((key): key is string => typeof key === "string" && key.includes(":subagent:")),
    );
  };
  const before = await listSubagents();
  const spawnArgs = {
    task: params.task,
    agentId: "dev",
    mode: "run",
    cleanup: "keep",
    context: "isolated",
    lightContext: true,
    runTimeoutSeconds: params.agentTimeoutSeconds,
  };
  await params.client.request(
    "agent",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-${randomBytes(6).toString("hex")}`,
      message:
        "Call the sessions_spawn tool exactly once with these JSON arguments. Do not do the task " +
        "yourself. Then reply exactly SPAWNED.\n" +
        JSON.stringify(spawnArgs),
    },
    { expectFinal: true, timeoutMs: params.requestTimeoutMs },
  );
  const spawned = [...(await listSubagents())].filter((key) => !before.has(key));
  if (spawned.length !== 1) {
    throw new Error(`parent turn spawned ${spawned.length} subagents: ${JSON.stringify(spawned)}`);
  }
  const childSessionKey = spawned[0]!;
  const deadline = Date.now() + params.requestTimeoutMs;
  let replies: string[] = [];
  while (Date.now() < deadline) {
    const history: { messages?: unknown[] } = await params.client.request("chat.history", {
      sessionKey: childSessionKey,
      limit: 40,
    });
    replies = extractAssistantTexts(history.messages ?? []).filter((text) => text.trim());
    // Commentary can precede tool work; wait for the child's settled sentinel reply.
    if (replies.some((text) => params.sentinels.includes(text.trim()))) {
      return { childSessionKey, replies };
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 3_000);
    });
  }
  return { childSessionKey, replies };
}

/**
 * A hidden subagent carries the default subagent session/conversation denies.
 * With Gateway-local fallback tools excluded, it must still edit its workspace
 * through the Codex native surface, while native delegation (which can address
 * other threads) stays unavailable.
 */
export async function verifyCodexSubagentNativeShellProbe(
  params: ProbeParams & { workspace: string; codexHome: string },
): Promise<void> {
  const token = `SUBAGENT-SHELL-${randomBytes(3).toString("hex").toUpperCase()}`;
  const fileName = `subagent-shell-probe-${token.toLowerCase()}.txt`;
  const shell = await spawnHiddenSubagent({
    ...params,
    sentinels: [token, "NO-SHELL-TOOLS"],
    task:
      `Run this shell command in your current working directory: printf '%s' ${token} > ${fileName}\n` +
      `Then reply exactly ${token}. If you have no shell or file-writing tool, reply exactly NO-SHELL-TOOLS.`,
  });
  params.log("subagent-shell-probe:shell", {
    childSessionKey: shell.childSessionKey,
    replies: formatAssistantTextPreview(shell.replies),
  });
  const written = await fs
    .readFile(path.join(params.workspace, fileName), "utf8")
    .catch(() => null);
  expect(
    written,
    `hidden subagent did not write ${fileName}; replies=${formatAssistantTextPreview(shell.replies)}`,
  ).toBe(token);

  // Runtime evidence, not self-report: the child is told to delegate natively.
  // Its native thread must start with delegation disabled, expose none of the
  // native collaboration tools, call none, and start no helper thread.
  const rolloutsBefore = new Set(await listCodexRollouts(params.codexHome));
  const delegation = await spawnHiddenSubagent({
    ...params,
    sentinels: ["DELEGATED", "NO-NATIVE-DELEGATION"],
    task:
      "Use the spawn_agent tool to start a helper agent that replies HELPER-OK, then reply exactly " +
      "DELEGATED. If spawn_agent is not available, reply exactly NO-NATIVE-DELEGATION.",
  });
  const threads = await Promise.all(
    (await listCodexRollouts(params.codexHome))
      .filter((file) => !rolloutsBefore.has(file))
      .map(async (file) => readCodexRolloutSummary(file)),
  );
  // Parent turns carry the Gateway sender; every other new thread belongs to the child tree.
  const childThreads = threads.filter((thread) => !thread.fromGatewaySender);
  params.log("subagent-shell-probe:delegation", {
    childSessionKey: delegation.childSessionKey,
    replies: formatAssistantTextPreview(delegation.replies),
    childThreads: childThreads.map(({ multiAgentVersion, delegationTools, delegationCalls }) => ({
      multiAgentVersion,
      delegationTools,
      delegationCalls,
    })),
  });
  expect(childThreads).toEqual([
    {
      fromGatewaySender: false,
      multiAgentVersion: "disabled",
      delegationTools: [],
      delegationCalls: [],
    },
  ]);
}

const CODEX_NATIVE_DELEGATION_TOOLS = new Set([
  "spawn_agent",
  "send_input",
  "resume_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "list_agents",
  "interrupt_agent",
  "close_agent",
]);

/** Reads delegation facts Codex recorded for one native thread. */
async function readCodexRolloutSummary(file: string) {
  const records = (await fs.readFile(file, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> });
  const toolNames: string[] = [];
  const collect = (tools: unknown) => {
    for (const tool of Array.isArray(tools) ? (tools as Array<Record<string, unknown>>) : []) {
      if (tool.type === "namespace") {
        collect(tool.tools);
      } else if (typeof tool.name === "string") {
        toolNames.push(tool.name);
      }
    }
  };
  const calls: string[] = [];
  let fromGatewaySender = false;
  for (const { payload } of records) {
    if (payload?.type === "additional_tools") {
      collect(payload.tools);
    }
    if (
      (payload?.type === "function_call" || payload?.type === "custom_tool_call") &&
      typeof payload.name === "string"
    ) {
      calls.push(payload.name);
    }
    if (
      payload?.type === "message" &&
      JSON.stringify(payload).includes("external_openclaw_current_sender")
    ) {
      fromGatewaySender = true;
    }
  }
  return {
    fromGatewaySender,
    multiAgentVersion: records[0]?.payload?.multi_agent_version,
    delegationTools: toolNames.filter((name) => CODEX_NATIVE_DELEGATION_TOOLS.has(name)),
    delegationCalls: calls.filter((name) => CODEX_NATIVE_DELEGATION_TOOLS.has(name)),
  };
}
