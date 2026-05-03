import crypto from "node:crypto";

type McpLoopbackRuntime = {
  port: number;
  ownerToken: string;
  nonOwnerToken: string;
};

export type McpLoopbackBearerContext = {
  senderIsOwner: boolean;
  ownerOnlyToolAllowlist?: string[];
  cronSelfRemoveOnlyJobId?: string;
};

let activeRuntime: McpLoopbackRuntime | undefined;
const scopedNonOwnerTokens = new Map<
  string,
  { ownerOnlyToolAllowlist: string[]; cronSelfRemoveOnlyJobId?: string }
>();

function normalizeOwnerOnlyToolAllowlist(value: string[] | undefined): string[] | undefined {
  const normalized = Array.from(
    new Set(
      value?.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0) ?? [],
    ),
  );
  return normalized.length > 0 ? normalized : undefined;
}

export function getActiveMcpLoopbackRuntime(): McpLoopbackRuntime | undefined {
  return activeRuntime ? { ...activeRuntime } : undefined;
}

export function setActiveMcpLoopbackRuntime(runtime: McpLoopbackRuntime): void {
  activeRuntime = { ...runtime };
}

export function resolveMcpLoopbackBearerToken(
  runtime: McpLoopbackRuntime,
  senderIsOwner: boolean,
): string {
  return senderIsOwner ? runtime.ownerToken : runtime.nonOwnerToken;
}

export function createMcpLoopbackScopedBearerToken(
  runtime: McpLoopbackRuntime,
  params: {
    senderIsOwner: boolean;
    ownerOnlyToolAllowlist?: string[];
    trigger?: string;
    jobId?: string;
  },
): string {
  if (params.senderIsOwner) {
    return runtime.ownerToken;
  }
  const normalizedAllowlist = normalizeOwnerOnlyToolAllowlist(params.ownerOnlyToolAllowlist);
  const cronSelfRemoveOnlyJobId =
    normalizedAllowlist?.includes("cron") && params.trigger === "cron" && params.jobId?.trim()
      ? params.jobId.trim()
      : undefined;
  const scopedAllowlist = normalizedAllowlist?.filter(
    (toolName) => toolName !== "cron" || Boolean(cronSelfRemoveOnlyJobId),
  );
  const ownerOnlyToolAllowlist =
    scopedAllowlist && scopedAllowlist.length > 0 ? scopedAllowlist : undefined;
  if (!ownerOnlyToolAllowlist) {
    return runtime.nonOwnerToken;
  }
  const token = crypto.randomBytes(32).toString("hex");
  scopedNonOwnerTokens.set(token, {
    ownerOnlyToolAllowlist,
    ...(cronSelfRemoveOnlyJobId ? { cronSelfRemoveOnlyJobId } : {}),
  });
  return token;
}

export function releaseMcpLoopbackScopedBearerToken(token: string): void {
  scopedNonOwnerTokens.delete(token);
}

export function resolveMcpLoopbackScopedBearerContext(
  token: string,
): McpLoopbackBearerContext | undefined {
  const grant = scopedNonOwnerTokens.get(token);
  if (!grant) {
    return undefined;
  }
  return {
    senderIsOwner: false,
    ownerOnlyToolAllowlist: grant.ownerOnlyToolAllowlist,
    ...(grant.cronSelfRemoveOnlyJobId
      ? { cronSelfRemoveOnlyJobId: grant.cronSelfRemoveOnlyJobId }
      : {}),
  };
}

export function clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken: string): void {
  if (activeRuntime?.ownerToken === ownerToken) {
    activeRuntime = undefined;
    scopedNonOwnerTokens.clear();
  }
}

export function createMcpLoopbackServerConfig(port: number) {
  return {
    mcpServers: {
      openclaw: {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp`,
        headers: {
          Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
          "x-session-key": "${OPENCLAW_MCP_SESSION_KEY}",
          "x-openclaw-agent-id": "${OPENCLAW_MCP_AGENT_ID}",
          "x-openclaw-account-id": "${OPENCLAW_MCP_ACCOUNT_ID}",
          "x-openclaw-message-channel": "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
        },
      },
    },
  };
}
