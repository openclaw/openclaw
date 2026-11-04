import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import type { ToolsInvokeResult } from "../../packages/gateway-protocol/src/index.js";
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
  const invoked = await params.client.request<ToolsInvokeResult>(
    "tools.invoke",
    {
      name: "sessions_spawn",
      sessionKey: params.sessionKey,
      args: {
        task: params.task,
        agentId: "dev",
        thinking: params.thinking,
        mode: "run",
        cleanup: "keep",
        context: "isolated",
        lightContext: true,
        expectsCompletionMessage: false,
        runTimeoutSeconds: params.agentTimeoutSeconds,
      },
    },
    { timeoutMs: params.requestTimeoutMs },
  );
  expect(invoked.ok, JSON.stringify(invoked)).toBe(true);
  const result = asOptionalRecord(asOptionalRecord(invoked.output)?.details);
  if (
    result?.status !== "accepted" ||
    typeof result.childSessionKey !== "string" ||
    !result.childSessionKey.includes(":subagent:") ||
    typeof result.runId !== "string"
  ) {
    throw new Error(`hidden subagent spawn failed: ${JSON.stringify(invoked)}`);
  }
  const waited: { status?: string } = await params.client.request(
    "agent.wait",
    { runId: result.runId, timeoutMs: params.requestTimeoutMs },
    { timeoutMs: params.requestTimeoutMs + 5_000 },
  );
  if (waited?.status !== "ok") {
    throw new Error(`agent.wait failed for ${result.runId}: ${JSON.stringify(waited)}`);
  }
  const history: { messages?: unknown[] } = await params.client.request("chat.history", {
    sessionKey: result.childSessionKey,
    limit: 40,
  });
  return {
    childSessionKey: result.childSessionKey,
    replies: extractAssistantTexts(history.messages ?? []),
  };
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
