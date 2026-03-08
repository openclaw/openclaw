import {
  createProvenanceRef,
  createRelationshipEdgeId,
  type EntityId,
  type JsonValue,
  type ProvenanceRef,
  type RelationshipEdge,
  type RelationshipEdgeType,
} from "../../../sre/contracts/entity.js";
import type {
  PluginHookAfterToolCallEvent,
  PluginHookBeforeMessageWriteEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookSubagentContext,
  PluginHookSubagentEndedEvent,
  PluginHookSubagentSpawnedEvent,
  PluginHookToolContext,
  PluginHookToolResultPersistContext,
  PluginHookToolResultPersistEvent,
} from "../../types.js";
import {
  createArtifactEntityId,
  createMessageEntityId,
  createRepoEntityId,
  createSessionEntityId,
  createThreadEntityId,
  createToolCallEntityId,
  createWorkdirEntityId,
  normalizeEntityId,
} from "./ids.js";
import type { RelationshipIndexNode, RelationshipIndexUpdate } from "./store.js";

type SessionWorkspaceInfo = {
  workspaceDir?: string;
  repoRoot?: string;
};

function entityKind(entityId: string | undefined): string | undefined {
  const normalized = normalizeEntityId(entityId);
  if (!normalized) {
    return undefined;
  }
  const index = normalized.indexOf(":");
  return index > 0 ? normalized.slice(0, index) : undefined;
}

function createNode(
  entityId: EntityId | undefined,
  entityType: string,
  observedAt: string,
  attributes?: { [key: string]: JsonValue },
): RelationshipIndexNode[] {
  if (!entityId) {
    return [];
  }
  return [
    {
      version: "sre.relationship-index-node.v1",
      entityId,
      entityType,
      observedAt,
      ...(attributes ? { attributes } : {}),
    },
  ];
}

function createEdge(params: {
  from: EntityId | undefined;
  to: EntityId | undefined;
  edgeType: RelationshipEdgeType;
  discoveredAt: string;
  provenance: ProvenanceRef[];
  attributes?: { [key: string]: JsonValue };
}): RelationshipEdge[] {
  if (!params.from || !params.to) {
    return [];
  }
  return [
    {
      version: "sre.relationship-edge.v1",
      edgeId: createRelationshipEdgeId({
        from: params.from,
        to: params.to,
        edgeType: params.edgeType,
      }),
      from: params.from,
      to: params.to,
      edgeType: params.edgeType,
      discoveredAt: params.discoveredAt,
      provenance: params.provenance,
      ...(params.attributes ? { attributes: params.attributes } : {}),
    },
  ];
}

function createRuntimeProvenanceRef(params: {
  hookName: string;
  discoveredAt: string;
  locator: string;
  sourceRefs?: string[];
  derivedFrom?: string[];
  confidence?: number;
}): ProvenanceRef {
  return createProvenanceRef({
    artifactType: "timeline_event",
    source: `runtime-hook:${params.hookName}`,
    locator: params.locator,
    capturedAt: params.discoveredAt,
    attributes: {
      ...(params.sourceRefs?.length ? { sourceRefs: params.sourceRefs } : {}),
      ...(params.derivedFrom?.length ? { derivedFrom: params.derivedFrom } : {}),
      ...(typeof params.confidence === "number" ? { confidence: params.confidence } : {}),
    },
  });
}

function buildSessionWorkspaceUpdate(
  sessionEntityId: EntityId | undefined,
  observedAt: string,
  provenance: ProvenanceRef,
  workspace: SessionWorkspaceInfo,
): RelationshipIndexUpdate {
  const workdirEntityId = createWorkdirEntityId(workspace.workspaceDir);
  const repoEntityId = createRepoEntityId(workspace);
  const nodes = [
    ...createNode(sessionEntityId, "session", observedAt),
    ...createNode(
      workdirEntityId,
      "workdir",
      observedAt,
      workspace.workspaceDir ? { path: workspace.workspaceDir } : {},
    ),
    ...createNode(repoEntityId, "github_repo", observedAt),
  ];
  const edges = [
    ...createEdge({
      from: sessionEntityId,
      to: repoEntityId ?? workdirEntityId,
      edgeType: "defined_in",
      discoveredAt: observedAt,
      provenance: [provenance],
    }),
  ];
  return { nodes, edges };
}

function mergeUpdates(...updates: RelationshipIndexUpdate[]): RelationshipIndexUpdate {
  const nodes = new Map<string, RelationshipIndexNode>();
  const edges = new Map<string, RelationshipEdge>();

  for (const update of updates) {
    for (const node of update.nodes) {
      nodes.set(node.entityId, node);
    }
    for (const edge of update.edges) {
      edges.set(edge.edgeId, edge);
    }
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
  };
}

export function buildMessageReceivedGraphUpdate(
  event: PluginHookMessageReceivedEvent,
  ctx: PluginHookMessageContext,
): RelationshipIndexUpdate {
  const observedAt = new Date(
    typeof event.timestamp === "number" ? event.timestamp : Date.now(),
  ).toISOString();
  const metadata = (event.metadata ?? {}) as {
    messageId?: string;
    threadId?: string | number;
    incidentId?: string;
  };
  const explicitParentKind = entityKind(event.parentEntityId);
  const messageEntityId =
    normalizeEntityId(event.entityId) ??
    createMessageEntityId({
      channelId: ctx.channelId,
      conversationId: ctx.conversationId,
      messageId: metadata.messageId,
    });
  const threadEntityId =
    (explicitParentKind === "thread" ? normalizeEntityId(event.parentEntityId) : undefined) ??
    createThreadEntityId({
      channelId: ctx.channelId,
      conversationId: ctx.conversationId,
      threadId: metadata.threadId,
    });
  const incidentEntityId =
    (explicitParentKind === "incident" ? normalizeEntityId(event.parentEntityId) : undefined) ??
    normalizeEntityId(metadata.incidentId);
  const provenance = createRuntimeProvenanceRef({
    hookName: "message_received",
    discoveredAt: observedAt,
    locator:
      metadata.messageId ?? `${ctx.channelId}:${ctx.conversationId ?? "conversation:unknown"}`,
    sourceRefs: event.sourceRefs,
    derivedFrom: event.derivedFrom,
    confidence: event.confidence,
  });

  return mergeUpdates({
    nodes: [
      ...createNode(messageEntityId, "message", observedAt),
      ...createNode(threadEntityId, "thread", observedAt),
      ...createNode(incidentEntityId, "incident", observedAt),
    ],
    edges: [
      ...createEdge({
        from: messageEntityId,
        to: threadEntityId,
        edgeType: "belongs_to",
        discoveredAt: observedAt,
        provenance: [provenance],
      }),
      ...createEdge({
        from: threadEntityId,
        to: incidentEntityId,
        edgeType: "belongs_to",
        discoveredAt: observedAt,
        provenance: [provenance],
      }),
    ],
  });
}

export function buildAfterToolCallGraphUpdate(
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,
  workspace: SessionWorkspaceInfo,
): RelationshipIndexUpdate {
  const observedAt = new Date().toISOString();
  const explicitParentKind = entityKind(event.parentEntityId);
  const toolEntityId =
    normalizeEntityId(event.entityId) ??
    createToolCallEntityId({
      runId: event.runId ?? ctx.runId,
      sessionKey: ctx.sessionKey,
      toolCallId: event.toolCallId ?? ctx.toolCallId,
      toolName: event.toolName,
    });
  const artifactEntityId =
    (explicitParentKind === "artifact" ? normalizeEntityId(event.parentEntityId) : undefined) ??
    createArtifactEntityId({
      toolName: event.toolName,
      toolCallId: event.toolCallId ?? ctx.toolCallId,
      runId: event.runId ?? ctx.runId,
      kind: event.error ? "error" : "result",
    });
  const sessionEntityId =
    (explicitParentKind === "session" ? normalizeEntityId(event.parentEntityId) : undefined) ??
    createSessionEntityId(ctx.sessionKey);
  const provenance = createRuntimeProvenanceRef({
    hookName: "after_tool_call",
    discoveredAt: observedAt,
    locator: event.toolCallId ?? event.toolName,
    sourceRefs: event.sourceRefs,
    derivedFrom: event.derivedFrom,
    confidence: event.confidence,
  });

  return mergeUpdates(
    {
      nodes: [
        ...createNode(toolEntityId, "tool_call", observedAt, {
          toolName: event.toolName,
        }),
        ...createNode(artifactEntityId, "artifact", observedAt, {
          toolName: event.toolName,
          ...(event.error ? { error: event.error } : {}),
        }),
      ],
      edges: createEdge({
        from: toolEntityId,
        to: artifactEntityId,
        edgeType: "calls",
        discoveredAt: observedAt,
        provenance: [provenance],
      }),
    },
    buildSessionWorkspaceUpdate(sessionEntityId, observedAt, provenance, workspace),
  );
}

export function buildToolResultPersistGraphUpdate(
  event: PluginHookToolResultPersistEvent,
  ctx: PluginHookToolResultPersistContext,
  workspace: SessionWorkspaceInfo,
): RelationshipIndexUpdate {
  const observedAt = new Date().toISOString();
  const sessionEntityId = createSessionEntityId(ctx.sessionKey);
  const provenance = createRuntimeProvenanceRef({
    hookName: "tool_result_persist",
    discoveredAt: observedAt,
    locator: event.toolCallId ?? event.toolName ?? "tool-result",
    sourceRefs: event.sourceRefs,
    derivedFrom: event.derivedFrom,
    confidence: event.confidence,
  });
  return buildSessionWorkspaceUpdate(sessionEntityId, observedAt, provenance, workspace);
}

export function buildBeforeMessageWriteGraphUpdate(
  event: PluginHookBeforeMessageWriteEvent,
  workspace: SessionWorkspaceInfo,
): RelationshipIndexUpdate {
  const observedAt = new Date().toISOString();
  const sessionEntityId = createSessionEntityId(event.sessionKey);
  const provenance = createRuntimeProvenanceRef({
    hookName: "before_message_write",
    discoveredAt: observedAt,
    locator: event.sessionKey ?? event.agentId ?? "message-write",
    sourceRefs: event.sourceRefs,
    derivedFrom: event.derivedFrom,
    confidence: event.confidence,
  });
  return buildSessionWorkspaceUpdate(sessionEntityId, observedAt, provenance, workspace);
}

export function buildSubagentSpawnedGraphUpdate(
  event: PluginHookSubagentSpawnedEvent,
  ctx: PluginHookSubagentContext,
  workspace: SessionWorkspaceInfo,
): RelationshipIndexUpdate {
  const observedAt = new Date().toISOString();
  const subagentEntityId =
    entityKind(event.entityId) === "subagent" ? normalizeEntityId(event.entityId) : undefined;
  const childSessionEntityId = createSessionEntityId(event.childSessionKey);
  const requesterSessionEntityId =
    (entityKind(event.parentEntityId) === "session"
      ? normalizeEntityId(event.parentEntityId)
      : undefined) ?? createSessionEntityId(ctx.requesterSessionKey);
  const provenance = createRuntimeProvenanceRef({
    hookName: "subagent_spawned",
    discoveredAt: observedAt,
    locator: event.runId,
    sourceRefs: event.sourceRefs,
    derivedFrom: event.derivedFrom,
    confidence: event.confidence,
  });

  return mergeUpdates(
    {
      nodes: [
        ...createNode(subagentEntityId, "subagent", observedAt, {
          childSessionKey: event.childSessionKey,
          agentId: event.agentId,
        }),
        ...createNode(childSessionEntityId, "session", observedAt, {
          childSessionKey: event.childSessionKey,
          agentId: event.agentId,
        }),
        ...createNode(
          requesterSessionEntityId,
          "session",
          observedAt,
          ctx.requesterSessionKey ? { requesterSessionKey: ctx.requesterSessionKey } : undefined,
        ),
      ],
      edges: createEdge({
        from: subagentEntityId ?? childSessionEntityId,
        to: requesterSessionEntityId,
        edgeType: "depends_on",
        discoveredAt: observedAt,
        provenance: [provenance],
      }),
    },
    buildSessionWorkspaceUpdate(childSessionEntityId, observedAt, provenance, workspace),
  );
}

export function buildSubagentEndedGraphUpdate(
  event: PluginHookSubagentEndedEvent,
  ctx: PluginHookSubagentContext,
): RelationshipIndexUpdate {
  const observedAt = new Date(event.endedAt ?? Date.now()).toISOString();
  const entityId =
    normalizeEntityId(event.entityId) ?? createSessionEntityId(event.targetSessionKey);
  const kind = entityKind(entityId) ?? "session";
  return {
    nodes: createNode(entityId, kind, observedAt, {
      targetKind: event.targetKind,
      reason: event.reason,
      ...(event.outcome ? { outcome: event.outcome } : {}),
      ...(event.error ? { error: event.error } : {}),
      ...(ctx.requesterSessionKey ? { requesterSessionKey: ctx.requesterSessionKey } : {}),
    }),
    edges: [],
  };
}
