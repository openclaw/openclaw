import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { GatewayClient } from "../../src/gateway/client.js";
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

type ProbeParams = {
  client: GatewayClient;
  sessionKey: string;
  thinking: string;
  requestTimeoutMs: number;
  agentTimeoutSeconds: number;
  log: (step: string, details?: Record<string, unknown>) => void;
};

async function spawnHiddenSubagent(
  params: ProbeParams & { task: string },
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
    if (replies.length > 0) {
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
  params: ProbeParams & { workspace: string },
): Promise<void> {
  const token = `SUBAGENT-SHELL-${randomBytes(3).toString("hex").toUpperCase()}`;
  const fileName = `subagent-shell-probe-${token.toLowerCase()}.txt`;
  const shell = await spawnHiddenSubagent({
    ...params,
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

  const delegation = await spawnHiddenSubagent({
    ...params,
    task:
      "List your available tools. If a tool named spawn_agent, send_input or resume_agent is " +
      "available, reply exactly NATIVE-DELEGATION-AVAILABLE. Otherwise reply exactly NO-NATIVE-DELEGATION.",
  });
  params.log("subagent-shell-probe:delegation", {
    childSessionKey: delegation.childSessionKey,
    replies: formatAssistantTextPreview(delegation.replies),
  });
  expect(
    delegation.replies.some((text) => text.trim() === "NO-NATIVE-DELEGATION"),
    `hidden subagent reported native delegation; replies=${formatAssistantTextPreview(delegation.replies)}`,
  ).toBe(true);
}
