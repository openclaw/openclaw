import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/config.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "../gateway/auth-mode-policy.js";
import {
  buildGatewayConnectionDetails,
  ensureExplicitGatewayAuth,
  resolveExplicitGatewayAuth,
} from "../gateway/call.js";
import { GatewayClient } from "../gateway/client.js";
import { GATEWAY_CLIENT_CAPS } from "../gateway/protocol/client-info.js";
import {
  type HelloOk,
  PROTOCOL_VERSION,
  type SessionsListParams,
  type SessionsPatchResult,
  type SessionsPatchParams,
} from "../gateway/protocol/index.js";
import { resolveConfiguredSecretInputString } from "../gateway/resolve-configured-secret-input-string.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { VERSION } from "../version.js";
import type { ResponseUsageMode, SessionInfo, SessionScope } from "./tui-types.js";

export type GatewayConnectionOptions = {
  url?: string;
  token?: string;
  password?: string;
};

export type ChatSendOptions = {
  sessionKey: string;
  message: string;
  thinking?: string;
  deliver?: boolean;
  timeoutMs?: number;
  runId?: string;
};

export type GatewayEvent = {
  event: string;
  payload?: unknown;
  seq?: number;
};

type ResolvedGatewayConnection = {
  url: string;
  token?: string;
  password?: string;
};

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function throwGatewayAuthResolutionError(reason: string): never {
  throw new Error(
    [
      reason,
      "Fix: set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD, pass --token/--password,",
      "or resolve the configured secret provider for this credential.",
    ].join("\n"),
  );
}

export type GatewaySessionList = {
  ts: number;
  path: string;
  count: number;
  defaults?: {
    model?: string | null;
    modelProvider?: string | null;
    contextTokens?: number | null;
  };
  sessions: Array<
    Pick<
      SessionInfo,
      | "thinkingLevel"
      | "verboseLevel"
      | "reasoningLevel"
      | "model"
      | "contextTokens"
      | "inputTokens"
      | "outputTokens"
      | "totalTokens"
      | "modelProvider"
      | "displayName"
    > & {
      key: string;
      sessionId?: string;
      updatedAt?: number | null;
      sendPolicy?: string;
      responseUsage?: ResponseUsageMode;
      label?: string;
      provider?: string;
      groupChannel?: string;
      space?: string;
      subject?: string;
      chatType?: string;
      lastProvider?: string;
      lastTo?: string;
      lastAccountId?: string;
      derivedTitle?: string;
      lastMessagePreview?: string;
    }
  >;
};

export type GatewayAgentsList = {
  defaultId: string;
  mainKey: string;
  scope: SessionScope;
  agents: Array<{
    id: string;
    name?: string;
  }>;
};

export type GatewayModelChoice = {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
};

export class GatewayChatClient {
  private client: GatewayClient;
  private readyPromise: Promise<void>;
  private resolveReady?: () => void;
  readonly connection: { url: string; token?: string; password?: string };
  hello?: HelloOk;

  onEvent?: (evt: GatewayEvent) => void;
  onConnected?: () => void;
  onDisconnected?: (reason: string) => void;
  onGap?: (info: { expected: number; received: number }) => void;

  constructor(connection: ResolvedGatewayConnection) {
    this.connection = connection;

    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    this.client = new GatewayClient({
      url: connection.url,
      token: connection.token,
      password: connection.password,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "openclaw-tui",
      clientVersion: VERSION,
      platform: process.platform,
      mode: GATEWAY_CLIENT_MODES.UI,
      caps: [GATEWAY_CLIENT_CAPS.TOOL_EVENTS],
      instanceId: randomUUID(),
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      onHelloOk: (hello) => {
        this.hello = hello;
        this.resolveReady?.();
        this.onConnected?.();
      },
      onEvent: (evt) => {
        this.onEvent?.({
          event: evt.event,
          payload: evt.payload,
          seq: evt.seq,
        });
      },
      onClose: (_code, reason) => {
        // Reset so waitForReady() blocks again until the next successful reconnect.
        this.readyPromise = new Promise((resolve) => {
          this.resolveReady = resolve;
        });
        this.onDisconnected?.(reason);
      },
      onGap: (info) => {
        this.onGap?.(info);
      },
    });
  }

  static async connect(opts: GatewayConnectionOptions): Promise<GatewayChatClient> {
    const connection = await resolveGatewayConnection(opts);
    return new GatewayChatClient(connection);
  }

  start() {
    this.client.start();
  }

  stop() {
    this.client.stop();
  }

  async waitForReady() {
    await this.readyPromise;
  }

  async sendChat(opts: ChatSendOptions): Promise<{ runId: string }> {
    const runId = opts.runId ?? randomUUID();
    await this.client.request("chat.send", {
      sessionKey: opts.sessionKey,
      message: opts.message,
      thinking: opts.thinking,
      deliver: opts.deliver,
      timeoutMs: opts.timeoutMs,
      idempotencyKey: runId,
    });
    return { runId };
  }

  async abortChat(opts: { sessionKey: string; runId: string }) {
    return await this.client.request<{ ok: boolean; aborted: boolean }>("chat.abort", {
      sessionKey: opts.sessionKey,
      runId: opts.runId,
    });
  }

  async loadHistory(opts: { sessionKey: string; limit?: number }) {
    return await this.client.request("chat.history", {
      sessionKey: opts.sessionKey,
      limit: opts.limit,
    });
  }

  async listSessions(opts?: SessionsListParams) {
    return await this.client.request<GatewaySessionList>("sessions.list", {
      limit: opts?.limit,
      activeMinutes: opts?.activeMinutes,
      includeGlobal: opts?.includeGlobal,
      includeUnknown: opts?.includeUnknown,
      includeDerivedTitles: opts?.includeDerivedTitles,
      includeLastMessage: opts?.includeLastMessage,
      agentId: opts?.agentId,
    });
  }

  async listAgents() {
    return await this.client.request<GatewayAgentsList>("agents.list", {});
  }

  async patchSession(opts: SessionsPatchParams): Promise<SessionsPatchResult> {
    return await this.client.request<SessionsPatchResult>("sessions.patch", opts);
  }

  async resetSession(key: string, reason?: "new" | "reset") {
    return await this.client.request("sessions.reset", {
      key,
      ...(reason ? { reason } : {}),
    });
  }

  async getStatus() {
    return await this.client.request("status");
  }

  async listModels(): Promise<GatewayModelChoice[]> {
    const res = await this.client.request<{ models?: GatewayModelChoice[] }>("models.list");
    return Array.isArray(res?.models) ? res.models : [];
  }
}

export async function resolveGatewayConnection(
  opts: GatewayConnectionOptions,
): Promise<ResolvedGatewayConnection> {
  const config = loadConfig();
  const env = process.env;
  const gatewayAuthMode = config.gateway?.auth?.mode;
  const isRemoteMode = config.gateway?.mode === "remote";
  const remote = config.gateway?.remote;
  const envToken = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
  const envPassword = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);

  const urlOverride =
    typeof opts.url === "string" && opts.url.trim().length > 0 ? opts.url.trim() : undefined;
  const explicitAuth = resolveExplicitGatewayAuth({ token: opts.token, password: opts.password });
  ensureExplicitGatewayAuth({
    urlOverride,
    urlOverrideSource: "cli",
    explicitAuth,
    errorHint: "Fix: pass --token or --password when using --url.",
  });
  const url = buildGatewayConnectionDetails({
    config,
    ...(urlOverride ? { url: urlOverride } : {}),
  }).url;

  if (urlOverride) {
    return {
      url,
      token: explicitAuth.token,
      password: explicitAuth.password,
    };
  }

  if (isRemoteMode) {
    const remoteToken = explicitAuth.token
      ? { value: explicitAuth.token }
      : await resolveConfiguredSecretInputString({
          value: remote?.token,
          path: "gateway.remote.token",
          env,
          config,
        });
    const remotePassword =
      explicitAuth.password || envPassword
        ? { value: explicitAuth.password ?? envPassword }
        : await resolveConfiguredSecretInputString({
            value: remote?.password,
            path: "gateway.remote.password",
            env,
            config,
          });

    const token = explicitAuth.token ?? remoteToken.value;
    const password = explicitAuth.password ?? envPassword ?? remotePassword.value;
    if (!token && !password) {
      throwGatewayAuthResolutionError(
        remoteToken.unresolvedRefReason ??
          remotePassword.unresolvedRefReason ??
          "Missing gateway auth credentials.",
      );
    }
    return { url, token, password };
  }

  if (gatewayAuthMode === "none" || gatewayAuthMode === "trusted-proxy") {
    return {
      url,
      token: explicitAuth.token ?? envToken,
      password: explicitAuth.password ?? envPassword,
    };
  }

  try {
    assertExplicitGatewayAuthModeWhenBothConfigured(config);
  } catch (err) {
    throwGatewayAuthResolutionError(err instanceof Error ? err.message : String(err));
  }

  const defaults = config.secrets?.defaults;
  const hasConfiguredToken = hasConfiguredSecretInput(config.gateway?.auth?.token, defaults);
  const hasConfiguredPassword = hasConfiguredSecretInput(config.gateway?.auth?.password, defaults);
  if (gatewayAuthMode === "password") {
    const localPassword =
      explicitAuth.password || envPassword
        ? { value: explicitAuth.password ?? envPassword }
        : await resolveConfiguredSecretInputString({
            value: config.gateway?.auth?.password,
            path: "gateway.auth.password",
            env,
            config,
          });
    const password = explicitAuth.password ?? envPassword ?? localPassword.value;
    if (!password) {
      throwGatewayAuthResolutionError(
        localPassword.unresolvedRefReason ?? "Missing gateway auth password.",
      );
    }
    return {
      url,
      token: explicitAuth.token ?? envToken,
      password,
    };
  }

  const resolveToken = async () => {
    const localToken =
      explicitAuth.token || envToken
        ? { value: explicitAuth.token ?? envToken }
        : await resolveConfiguredSecretInputString({
            value: config.gateway?.auth?.token,
            path: "gateway.auth.token",
            env,
            config,
          });
    const token = explicitAuth.token ?? envToken ?? localToken.value;
    if (!token) {
      throwGatewayAuthResolutionError(
        localToken.unresolvedRefReason ?? "Missing gateway auth token.",
      );
    }
    return token;
  };

  if (gatewayAuthMode === "token") {
    const token = await resolveToken();
    return {
      url,
      token,
      password: explicitAuth.password ?? envPassword,
    };
  }

  const passwordCandidate = explicitAuth.password ?? envPassword;
  const shouldUsePassword =
    Boolean(passwordCandidate) || (hasConfiguredPassword && !hasConfiguredToken);

  if (shouldUsePassword) {
    const localPassword = passwordCandidate
      ? { value: passwordCandidate }
      : await resolveConfiguredSecretInputString({
          value: config.gateway?.auth?.password,
          path: "gateway.auth.password",
          env,
          config,
        });
    const password = passwordCandidate ?? localPassword.value;
    if (!password) {
      throwGatewayAuthResolutionError(
        localPassword.unresolvedRefReason ?? "Missing gateway auth password.",
      );
    }
    return {
      url,
      token: explicitAuth.token ?? envToken,
      password,
    };
  }

  const token = await resolveToken();
  return {
    url,
    token,
    password: explicitAuth.password ?? envPassword,
  };
}
