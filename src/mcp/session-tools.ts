// Session MCP tools expose a bounded, opaque view of Gateway-managed sessions.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  ADMIN_SCOPE,
  abortResultSchema,
  type AgentsListResult,
  agentsListResultSchema,
  createResultSchema,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_LIST_LIMIT,
  historyResultSchema,
  MAX_HISTORY_CHARS,
  MAX_SESSION_MAPPINGS,
  MAX_TITLE_CHARS,
  parseGatewayResult,
  patchResultSchema,
  READ_SCOPE,
  sendResultSchema,
  type SessionAbortInput,
  type SessionAgent,
  type SessionCapabilities,
  type SessionCreateInput,
  type SessionDetailInput,
  type SessionItem,
  type SessionListInput,
  type SessionSendInput,
  type SessionStatus,
  SessionToolError,
  type SessionToolsGateway,
  type SessionUpdateInput,
  sessionsListResultSchema,
  type StoredSession,
  WRITE_SCOPE,
} from "./session-tools-contract.js";
import {
  boundedText,
  boundedSessionListIcons,
  defaultCollectionRows,
  isoTimestamp,
  numberField,
  sessionAgent,
  sessionItem,
  stringField,
  visibleMessages,
} from "./session-tools-projection.js";

export type { SessionCapabilities } from "./session-tools-contract.js";

/** Owns opaque session ids and the narrow Gateway projection used by MCP tools. */
export class OpenClawSessionTools {
  private readonly opaqueIdKey = randomBytes(32);
  private readonly sessionsById = new Map<string, StoredSession>();

  constructor(private readonly gateway: SessionToolsGateway) {}

  clear(): void {
    this.sessionsById.clear();
  }

  capabilities(): SessionCapabilities {
    const { methods, scopes } = this.gateway.access();
    const canWrite = scopes.has(WRITE_SCOPE) || scopes.has(ADMIN_SCOPE);
    const canRead = scopes.has(READ_SCOPE) || canWrite;
    return {
      list: canRead && methods.has("sessions.list"),
      read: canRead && methods.has("chat.history"),
      create: canWrite && methods.has("sessions.create"),
      send: canWrite && (methods.has("sessions.send") || methods.has("chat.send")),
      abort: canWrite && (methods.has("sessions.abort") || methods.has("chat.abort")),
      update: canWrite && methods.has("sessions.patch"),
    };
  }

  async list(params: SessionListInput): Promise<{
    items: SessionItem[];
    agents: SessionAgent[];
    capabilities: SessionCapabilities;
  }> {
    await this.waitUntilReady();
    this.requireCapability("list");
    const limit = params.limit ?? DEFAULT_LIST_LIMIT;
    const archivedStates = params.archived == null ? [false, true] : [params.archived];
    const [sessionResultsRaw, agents] = await Promise.all([
      Promise.all(
        archivedStates.map((archived) =>
          this.gateway.request("sessions.list", {
            limit,
            search: params.search,
            archived,
            configuredAgentsOnly: true,
            includeDerivedTitles: true,
            includeLastMessage: true,
          }),
        ),
      ),
      this.listAgents(),
    ]);
    const sessionResults = sessionResultsRaw.map((result) =>
      parseGatewayResult(sessionsListResultSchema, result),
    );
    const rows =
      params.archived == null
        ? defaultCollectionRows(
            sessionResults[0]?.sessions ?? [],
            sessionResults[1]?.sessions ?? [],
            limit,
          )
        : (sessionResults[0]?.sessions.slice(0, limit) ?? []);
    const agentsById = new Map(agents.agents.map((agent) => [agent.id, agent]));
    const items = rows.map((row) => {
      const agentId = parseAgentSessionKey(row.key)?.agentId ?? agents.defaultId ?? "main";
      const item = sessionItem(
        row,
        agentId,
        this.opaqueSessionId(row.key),
        agentsById.get(agentId),
      );
      this.rememberSession({ key: row.key, agentId, item });
      return item;
    });
    return {
      ...boundedSessionListIcons(items, [...agentsById.values()].map(sessionAgent)),
      capabilities: this.capabilities(),
    };
  }

  async detail(params: SessionDetailInput): Promise<{
    session?: SessionItem;
    messages?: Array<{ role: "user" | "assistant"; text: string }>;
    agents?: SessionAgent[];
    mode?: "new";
    capabilities: SessionCapabilities;
  }> {
    await this.waitUntilReady();
    if (params.mode === "new") {
      const agents = await this.listAgents();
      const projectedAgents = boundedSessionListIcons([], agents.agents.map(sessionAgent)).agents;
      return {
        mode: "new",
        agents: projectedAgents,
        capabilities: this.capabilities(),
      };
    }
    if (params.session_id === undefined) {
      throw new SessionToolError("rejected");
    }
    this.requireCapability("read");
    const session = this.requireSession(params.session_id);
    const raw = await this.gateway.request("chat.history", {
      sessionKey: session.key,
      agentId: session.agentId,
      limit: params.limit ?? DEFAULT_HISTORY_LIMIT,
      maxChars: MAX_HISTORY_CHARS,
    });
    const history = parseGatewayResult(historyResultSchema, raw);
    return {
      session: session.item,
      messages: visibleMessages(history.messages),
      capabilities: this.capabilities(),
    };
  }

  async create(params: SessionCreateInput): Promise<{
    session: SessionItem;
    run_id?: string;
    initial_message_status?: "failed";
    capabilities: SessionCapabilities;
  }> {
    await this.waitUntilReady();
    this.requireCapability("create");
    const operationSessionKey = params.operation_id
      ? this.operationSessionKey(params.agent_id, params.operation_id)
      : undefined;
    const raw = await this.gateway.request("sessions.create", {
      key: operationSessionKey,
      agentId: params.agent_id,
      label: params.label,
      message: operationSessionKey ? undefined : params.message,
    });
    const created = parseGatewayResult(createResultSchema, raw);
    const agentId = params.agent_id ?? parseAgentSessionKey(created.key)?.agentId ?? "main";
    let runId = created.runId;
    let runStarted = created.runStarted === true;
    let initialMessageFailed = params.message != null && created.runStarted === false;
    if (params.operation_id && params.message) {
      try {
        const sent = await this.sendGatewayMessage(
          { key: created.key, agentId },
          params.message,
          params.operation_id,
        );
        runId = sent.runId;
        runStarted = true;
        initialMessageFailed = false;
      } catch {
        initialMessageFailed = true;
      }
    }
    const entry = created.entry ?? {};
    const item = sessionItem(
      {
        key: created.key,
        label: stringField(entry, "label") ?? params.label,
        updatedAt: numberField(entry, "updatedAt"),
        hasActiveRun: runStarted,
      },
      agentId,
      this.opaqueSessionId(created.key),
    );
    this.rememberSession({ key: created.key, agentId, item });
    return {
      session: item,
      ...(runId ? { run_id: runId } : {}),
      ...(initialMessageFailed ? { initial_message_status: "failed" as const } : {}),
      capabilities: this.capabilities(),
    };
  }

  async send(params: SessionSendInput): Promise<{
    session_id: string;
    run_id?: string;
    status: SessionStatus;
    capabilities: SessionCapabilities;
  }> {
    await this.waitUntilReady();
    this.requireCapability("send");
    const session = this.requireSession(params.session_id);
    const sent = await this.sendGatewayMessage(
      session,
      params.text,
      params.operation_id ?? randomUUID(),
    );
    session.item = { ...session.item, status: "working" };
    return {
      session_id: session.item.id,
      ...(sent.runId ? { run_id: sent.runId } : {}),
      status: "working",
      capabilities: this.capabilities(),
    };
  }

  async abort(params: SessionAbortInput): Promise<{
    session_id: string;
    aborted: boolean;
    status: SessionStatus;
    capabilities: SessionCapabilities;
  }> {
    await this.waitUntilReady();
    this.requireCapability("abort");
    const session = this.requireSession(params.session_id);
    const { methods } = this.gateway.access();
    const method = methods.has("sessions.abort") ? "sessions.abort" : "chat.abort";
    const runId = params.run_id;
    const raw = await this.gateway.request(
      method,
      method === "sessions.abort"
        ? {
            key: session.key,
            agentId: session.agentId,
            ...(runId ? { runId } : {}),
          }
        : {
            sessionKey: session.key,
            agentId: session.agentId,
            ...(runId ? { runId } : {}),
          },
    );
    const abortedResult = parseGatewayResult(abortResultSchema, raw);
    const aborted =
      abortedResult.aborted === true ||
      abortedResult.status === "aborted" ||
      typeof abortedResult.abortedRunId === "string";
    session.item = { ...session.item, status: "idle" };
    return {
      session_id: session.item.id,
      aborted,
      status: "idle",
      capabilities: this.capabilities(),
    };
  }

  async update(params: SessionUpdateInput): Promise<{
    session: SessionItem;
    capabilities: SessionCapabilities;
  }> {
    await this.waitUntilReady();
    this.requireCapability("update");
    const session = this.requireSession(params.session_id);
    const raw = await this.gateway.request("sessions.patch", {
      key: session.key,
      agentId: session.agentId,
      label: params.label,
      archived: params.archived,
      pinned: params.pinned,
      unread: params.unread,
    });
    const patched = parseGatewayResult(patchResultSchema, raw);
    session.item = {
      ...session.item,
      title:
        boundedText(stringField(patched.entry, "label") ?? params.label, MAX_TITLE_CHARS) ??
        session.item.title,
      updatedAt: isoTimestamp(numberField(patched.entry, "updatedAt")) ?? session.item.updatedAt,
      archived: params.archived ?? session.item.archived,
      pinned: params.pinned ?? session.item.pinned,
      unread: params.unread ?? session.item.unread,
    };
    return { session: session.item, capabilities: this.capabilities() };
  }

  async open(): Promise<{
    items: SessionItem[];
    agents: SessionAgent[];
    capabilities: SessionCapabilities;
  }> {
    await this.waitUntilReady();
    if (!this.capabilities().list) {
      return { items: [], agents: [], capabilities: this.capabilities() };
    }
    return await this.list({});
  }

  private requireCapability(capability: keyof SessionCapabilities): void {
    if (!this.capabilities()[capability]) {
      throw new SessionToolError("unsupported");
    }
  }

  private async sendGatewayMessage(
    session: Pick<StoredSession, "key" | "agentId">,
    text: string,
    idempotencyKey: string,
  ) {
    const { methods } = this.gateway.access();
    const method = methods.has("sessions.send") ? "sessions.send" : "chat.send";
    if (!methods.has(method)) {
      throw new SessionToolError("unsupported");
    }
    const raw = await this.gateway.request(
      method,
      method === "sessions.send"
        ? { key: session.key, agentId: session.agentId, message: text, idempotencyKey }
        : { sessionKey: session.key, agentId: session.agentId, message: text, idempotencyKey },
    );
    return parseGatewayResult(sendResultSchema, raw);
  }

  private operationSessionKey(agentId: string | undefined, operationId: string): string {
    const normalizedAgentId = normalizeAgentId(agentId ?? "main");
    const suffix = createHmac("sha256", this.opaqueIdKey)
      .update(`create\0${normalizedAgentId}\0${operationId}`)
      .digest("base64url")
      .slice(0, 32);
    return `agent:${normalizedAgentId}:dashboard:codex-${suffix}`;
  }

  private requireSession(id: string): StoredSession {
    const session = this.sessionsById.get(id);
    if (!session) {
      throw new SessionToolError("refresh_required");
    }
    return session;
  }

  private rememberSession(session: StoredSession): void {
    this.sessionsById.delete(session.item.id);
    this.sessionsById.set(session.item.id, session);
    while (this.sessionsById.size > MAX_SESSION_MAPPINGS) {
      const oldestId = this.sessionsById.keys().next().value;
      if (typeof oldestId !== "string") {
        return;
      }
      this.sessionsById.delete(oldestId);
    }
  }

  private opaqueSessionId(key: string): string {
    return createHmac("sha256", this.opaqueIdKey).update(key).digest("base64url");
  }

  private async listAgents(): Promise<AgentsListResult> {
    if (!this.gateway.access().methods.has("agents.list")) {
      return { agents: [] };
    }
    return parseGatewayResult(
      agentsListResultSchema,
      await this.gateway.request("agents.list", {}),
    );
  }

  private async waitUntilReady(): Promise<void> {
    await this.gateway.ready?.();
  }
}
