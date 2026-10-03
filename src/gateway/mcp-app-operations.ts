import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type ListResourcesRequest,
  ListResourcesRequestSchema,
  type ListResourceTemplatesRequest,
  ListResourceTemplatesRequestSchema,
  type ListToolsRequest,
  ListToolsRequestSchema,
  type ReadResourceRequest,
  ReadResourceRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { peekSessionMcpRuntime } from "../agents/agent-bundle-mcp-manager-api.js";
import { completeDeferredSessionMcpRuntimeRetirement } from "../agents/agent-bundle-mcp-manager-cleanup.js";
import {
  getSessionMcpRequestSignal,
  runWithSessionMcpRequestSignal,
} from "../agents/agent-bundle-mcp-request-context.js";
import type { McpCatalogTool, SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import {
  createMcpClientElicitationHandler,
  runWithMcpElicitationHandler,
} from "../agents/mcp-client-elicitation.js";
import {
  acquireMcpAppViewRequest,
  getMcpAppViewLease,
  getMcpAppViewLeaseForSession,
  type McpAppFormOrigin,
  type McpFormResourceUpload,
  type McpAppViewLease,
} from "../agents/mcp-ui-resource.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { restoreMcpAppView } from "./mcp-app-reconstruction.js";
import { resolveGatewayOperatorRoleActor } from "./operator-role-policy.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

export function resolveMcpAppRequesterId(
  client: GatewayRequestHandlerOptions["client"],
): string | undefined {
  const actor = resolveGatewayOperatorRoleActor(client);
  return (
    client?.authenticatedUserProfile?.profileId ??
    (actor?.kind === "operator" ? actor.profileId : undefined)
  );
}

export type McpAppActiveView = {
  runtime: SessionMcpRuntime;
  view: McpAppViewLease;
};

export class McpAppViewExpiredError extends Error {
  constructor() {
    super("MCP App view expired or is not authorized for this session");
    this.name = "McpAppViewExpiredError";
  }
}

export type McpAppOperation =
  | Pick<CallToolRequest, "method" | "params">
  | Pick<ListToolsRequest, "method" | "params">
  | Pick<ListResourcesRequest, "method" | "params">
  | Pick<ListResourceTemplatesRequest, "method" | "params">
  | Pick<ReadResourceRequest, "method" | "params">;

function isAppCallableTool(
  view: Pick<McpAppViewLease, "serverName" | "allowedAppToolNames">,
  tool: McpCatalogTool,
): boolean {
  return (
    tool.serverName === view.serverName &&
    (tool.uiVisibility === undefined || tool.uiVisibility.includes("app")) &&
    (view.allowedAppToolNames === undefined || view.allowedAppToolNames.has(tool.toolName))
  );
}

function isAppCallableListedTool(tool: Tool): boolean {
  const visibility = asOptionalRecord(tool._meta?.ui)?.visibility;
  return !Array.isArray(visibility) || visibility.includes("app");
}

export async function requireMcpAppInteraction(view: McpAppViewLease): Promise<void> {
  if (view.readOnly === true || view.allowedAppToolNames === undefined) {
    throw new Error("MCP App view is read-only");
  }
  if (view.authorizeAppInteraction && !(await view.authorizeAppInteraction())) {
    throw new Error("MCP App widget grant is no longer active");
  }
}

export async function resolveMcpAppAllowedToolNames(active: McpAppActiveView): Promise<string[]> {
  if (active.view.readOnly === true || active.view.allowedAppToolNames === undefined) {
    return [];
  }
  const catalog = await active.runtime.getCatalog();
  return catalog.tools
    .filter((tool) => isAppCallableTool(active.view, tool))
    .map((tool) => tool.toolName)
    .filter((toolName, index, all) => all.indexOf(toolName) === index)
    .toSorted();
}

async function getRequestCatalog(runtime: SessionMcpRuntime) {
  const signal = getSessionMcpRequestSignal();
  signal?.throwIfAborted();
  // A caller can leave the wait, but the session still owns its shared refresh.
  return racePromiseWithAbortSignal(runtime.getCatalog(), signal);
}

async function requireCallableTool(
  runtime: SessionMcpRuntime,
  view: McpAppViewLease,
  toolName: string,
): Promise<void> {
  await requireMcpAppInteraction(view);
  const catalog = await getRequestCatalog(runtime);
  const tool = catalog.tools.find(
    (entry) => entry.serverName === view.serverName && entry.toolName === toolName,
  );
  if (!tool || !isAppCallableTool(view, tool)) {
    throw new Error(`MCP tool "${toolName}" is not app-callable`);
  }
}

export async function resolveMcpAppActiveView(params: {
  sessionKey: string;
  agentId?: string;
  viewId: string;
  cfg?: OpenClawConfig;
  restore?: boolean;
  requesterId?: string;
}): Promise<McpAppActiveView> {
  const requireRequester = (active: McpAppActiveView) => {
    if (active.view.requesterId !== undefined && active.view.requesterId !== params.requesterId) {
      throw new McpAppViewExpiredError();
    }
    active.runtime.assertOwnerCurrent?.();
    return active;
  };
  if (params.cfg && params.cfg.mcp?.apps?.enabled !== true) {
    throw new Error("MCP App runtime is unavailable");
  }
  const liveView = params.agentId
    ? getMcpAppViewLeaseForSession(params.viewId, params.sessionKey, params.agentId)
    : undefined;
  if (liveView) {
    if (liveView.runtime.mcpAppsEnabled !== true) {
      throw new Error("MCP App runtime is unavailable");
    }
    return requireRequester({ runtime: liveView.runtime, view: liveView });
  }
  // An unscoped runtime key cannot prove its owning agent. Prefer transcript
  // restoration with the prepared owner instead of adopting a sibling runtime.
  const existingRuntime =
    params.agentId && !parseAgentSessionKey(params.sessionKey)
      ? undefined
      : peekSessionMcpRuntime({ sessionKey: params.sessionKey });
  if (existingRuntime && existingRuntime.mcpAppsEnabled !== true) {
    throw new Error("MCP App runtime is unavailable");
  }
  const existingView = existingRuntime
    ? getMcpAppViewLease(params.viewId, existingRuntime)
    : undefined;
  const restored =
    existingRuntime?.mcpAppsEnabled === true && existingView
      ? { runtime: existingRuntime, view: existingView }
      : params.cfg && params.restore !== false
        ? await restoreMcpAppView({
            cfg: params.cfg,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            viewId: params.viewId,
          })
        : undefined;
  if (!restored) {
    throw new McpAppViewExpiredError();
  }
  return requireRequester(restored);
}

export async function withMcpAppActiveView<T>(
  active: McpAppActiveView,
  kind: "read" | "tool",
  operation: () => Promise<T> | T,
): Promise<T> {
  active.runtime.assertOwnerCurrent?.();
  active.runtime.markUsed();
  const release = acquireMcpAppViewRequest(active.view, kind);
  const releaseRuntimeLease = active.runtime.acquireLease?.();
  try {
    return await operation();
  } finally {
    release();
    releaseRuntimeLease?.();
    await completeDeferredSessionMcpRuntimeRetirement(active.runtime).catch((error: unknown) => {
      // A completed app tool call may have side effects. Cleanup failure must
      // never turn its successful response into an apparent retryable failure.
      logWarn(`mcp-app: deferred runtime cleanup failed: ${formatErrorMessage(error)}`);
    });
  }
}

async function withMcpAppReadAuthority<T>(
  active: McpAppActiveView,
  operation: () => Promise<T>,
): Promise<T> {
  return await withMcpAppActiveView(active, "read", async () => {
    await requireMcpAppInteraction(active.view);
    const result = await operation();
    // Read results may contain protected data. Recheck after upstream work
    // so a grant revoked in flight cannot disclose the completed response.
    await requireMcpAppInteraction(active.view);
    return result;
  });
}

/** Model-created views retain a tool allowlist, not authority to skip current approval policy. */
export async function prepareModelCreatedAppToolCall(
  active: {
    runtime: SessionMcpRuntime;
    view: Pick<
      McpAppViewLease,
      "serverName" | "sessionId" | "agentId" | "requesterId" | "allowedAppToolNames"
    >;
  },
  request: {
    options: GatewayRequestHandlerOptions;
    toolName: string;
    input: Record<string, unknown>;
    assertCurrent: () => void;
  },
): Promise<() => void> {
  const [
    { loadSessionMcpConfig },
    { buildBundleMcpToolsFromCatalog },
    { getPluginToolMeta },
    { isMcpToolAllowed, normalizeMcpToolFilter },
    { requiresMcpCodexToolApproval, resolveProjectedMcpCodexToolApprovalMode },
    { getSessionRowProjection },
    { resolveSessionResourceToolPolicy },
    { requestMcpAppToolApproval },
  ] = await Promise.all([
    import("../agents/agent-bundle-mcp-runtime-config.js"),
    import("../agents/agent-bundle-mcp-materialize.js"),
    import("../plugins/tool-metadata.js"),
    import("../agents/mcp-tool-filter.js"),
    import("../agents/mcp-codex-tool-approval.js"),
    import("./session-row-projection-access.js"),
    import("./session-resource-tool-policy.js"),
    import("./mcp-app-tool-approval.js"),
  ]);
  request.assertCurrent();
  const { runtime, view } = active;
  const { options } = request;
  const sessionKey = runtime.sessionKey;
  const projection = getSessionRowProjection(options.context);
  if (!sessionKey || !projection) {
    throw new Error("MCP App current session policy is unavailable");
  }
  const cfg = options.context.getRuntimeConfig();
  const query = { agentId: view.agentId, key: sessionKey };
  const requesterId = resolveMcpAppRequesterId(options.client);
  const current = () => {
    request.assertCurrent();
    if (
      options.context.getRuntimeConfig() !== cfg ||
      cfg.mcp?.apps?.enabled !== true ||
      getSessionRowProjection(options.context) !== projection ||
      resolveMcpAppRequesterId(options.client) !== requesterId ||
      (view.requesterId !== undefined && requesterId !== view.requesterId)
    ) {
      throw new Error("MCP App requester or configuration changed");
    }
    const target = projection.sharingTarget(query);
    if (
      !target ||
      target.entry.sessionId !== runtime.sessionId ||
      view.sessionId !== runtime.sessionId
    ) {
      throw new Error("MCP App session changed");
    }
    return target;
  };
  const initial = current();
  const expectedLifecycleRevision = initial.entry.lifecycleRevision;
  const { loaded } = loadSessionMcpConfig({
    workspaceDir: runtime.workspaceDir,
    cfg,
    toolOverrides: initial.entry.toolOverrides,
  });
  const rawServer = loaded.mcpServers[view.serverName];
  const catalog = runtime.peekCatalog();
  const server = catalog?.servers[view.serverName];
  const tool = catalog?.tools.find(
    (entry) => entry.serverName === view.serverName && entry.toolName === request.toolName,
  );
  if (
    !catalog ||
    !server ||
    !tool ||
    (!rawServer && !(runtime.assertOwnerCurrent && server.pluginId))
  ) {
    throw new Error("MCP App approval origin is not known to the current server/native owner");
  }
  const projected = buildBundleMcpToolsFromCatalog({ catalog, includeAppOnlyInventory: true }).find(
    (entry) => {
      const mcp = getPluginToolMeta(entry)?.mcp;
      return (
        mcp?.operation === "tool" &&
        mcp.serverName === view.serverName &&
        mcp.toolName === request.toolName
      );
    },
  );
  if (!projected) {
    throw new Error("MCP App current tool projection is unavailable");
  }
  const expectedToolPolicy = JSON.stringify({ server, tool });
  const assertPolicy = () => {
    const live = current();
    if (live.entry.lifecycleRevision !== expectedLifecycleRevision) {
      throw new Error("MCP App session lifecycle changed");
    }
    const currentCatalog = runtime.peekCatalog();
    const currentTool = currentCatalog?.tools.find(
      (entry) => entry.serverName === view.serverName && entry.toolName === request.toolName,
    );
    if (
      !currentTool ||
      !isAppCallableTool(view, currentTool) ||
      currentTool.deniedBySession ||
      JSON.stringify({ server: currentCatalog?.servers[view.serverName], tool: currentTool }) !==
        expectedToolPolicy ||
      live.entry.toolOverrides?.mcpServers?.[view.serverName] === false ||
      live.entry.toolOverrides?.mcpToolsDeny?.[view.serverName]?.includes(request.toolName) ||
      (rawServer &&
        !isMcpToolAllowed(normalizeMcpToolFilter(rawServer.toolFilter), request.toolName))
    ) {
      throw new Error("MCP App tool is denied by current policy");
    }
    resolveSessionResourceToolPolicy({
      config: cfg,
      client: options.client,
      current: live,
      readPreparedSessionEntry: (source) => projection.sharingTarget(source)?.entry,
      toolName: projected.name,
      assertNativeRuntimeCurrent: runtime.assertOwnerCurrent,
    });
    // Native plugin inventory supplies identity, not an implicit allow grant.
    return requiresMcpCodexToolApproval({
      mode: rawServer
        ? resolveProjectedMcpCodexToolApprovalMode(view.serverName, rawServer)
        : "prompt",
      fullPermission: live.entry.permissionMode === "full",
      annotations: currentTool.codexAnnotations,
    });
  };
  const approvalRequired = assertPolicy();
  if (approvalRequired) {
    await requestMcpAppToolApproval({
      options,
      agentId: view.agentId,
      sessionKey,
      serverName: view.serverName,
      toolName: request.toolName,
      input: request.input,
      signal: options.signal,
      assertCurrent: () => {
        assertPolicy();
      },
    });
  }
  const assertExecutionCurrent = () => {
    if (assertPolicy() && !approvalRequired) {
      throw new Error("MCP App approval policy changed before execution");
    }
  };
  assertExecutionCurrent();
  return assertExecutionCurrent;
}

export async function executeMcpAppOperation(
  active: McpAppActiveView,
  operation: McpAppOperation,
  request?: { options: GatewayRequestHandlerOptions; assertCurrent: () => void },
): Promise<unknown> {
  const { runtime, view } = active;
  if (operation.method === "tools/call") {
    return await withMcpAppActiveView(active, "tool", async () => {
      await requireCallableTool(runtime, view, operation.params.name);
      await requireMcpAppInteraction(view);
      const input = operation.params.arguments ?? {};
      const assertViewCurrent = () => {
        request?.assertCurrent();
        runtime.assertOwnerCurrent?.();
        request?.options.signal?.throwIfAborted();
        if (
          getMcpAppViewLease(view.viewId, runtime) !== view ||
          view.readOnly ||
          view.allowedAppToolNames === undefined
        ) {
          throw new McpAppViewExpiredError();
        }
      };
      let assertPreparedPolicy: void | (() => void);
      const assertCurrent = () => {
        assertViewCurrent();
        if (assertPreparedPolicy) {
          assertPreparedPolicy();
        }
      };
      if (view.prepareToolCall) {
        if (!request) {
          throw new Error("This App tool requires an authenticated request for approval");
        }
        assertPreparedPolicy = await view.prepareToolCall({
          options: request.options,
          toolName: operation.params.name,
          input,
          assertCurrent: assertViewCurrent,
          signal: request.options.signal,
        });
        assertCurrent();
      } else if (request) {
        assertPreparedPolicy = await prepareModelCreatedAppToolCall(active, {
          options: request.options,
          toolName: operation.params.name,
          input,
          assertCurrent: assertViewCurrent,
        });
      }
      await requireMcpAppInteraction(view);
      if (request) {
        if (!runtime.sessionKey) {
          throw new Error("MCP App session is unavailable");
        }
        assertCurrent();
        return await callMcpAppToolWithElicitation({
          options: request.options,
          origin: {
            runtime,
            serverName: view.serverName,
            agentId: view.agentId,
            sessionKey: runtime.sessionKey,
            requesterId: resolveMcpAppRequesterId(request.options.client),
            assertCurrent,
            prepareToolCall: view.prepareToolCall,
          },
          toolName: operation.params.name,
          input,
          assertCurrent,
          uploadResources: view.uploadResources,
          ...(view.hostFile
            ? {
                _meta: {
                  "openai/resource": { path: path.join(view.hostFile.rootDir, view.hostFile.path) },
                },
              }
            : {}),
        });
      }
      if (view.hostFile) {
        return await runtime.callTool(view.serverName, operation.params.name, input, {
          _meta: {
            "openai/resource": { path: path.join(view.hostFile.rootDir, view.hostFile.path) },
          },
        });
      }
      return await runtime.callTool(view.serverName, operation.params.name, input);
    });
  }
  return await withMcpAppReadAuthority(active, async () => {
    switch (operation.method) {
      case "tools/list": {
        if (!runtime.listTools) {
          throw new Error("MCP tools/list is unavailable");
        }
        const [listed, catalog] = await Promise.all([
          runtime.listTools(
            view.serverName,
            operation.params?.cursor ? { cursor: operation.params.cursor } : undefined,
          ),
          getRequestCatalog(runtime),
        ]);
        const allowed = new Set(
          catalog.tools
            .filter((tool) => isAppCallableTool(view, tool))
            .map((tool) => tool.toolName),
        );
        return {
          ...listed,
          tools: listed.tools.filter(
            (tool) => allowed.has(tool.name.trim()) && isAppCallableListedTool(tool),
          ),
        };
      }
      case "resources/list": {
        if (!runtime.listResources) {
          throw new Error("MCP resources/list is unavailable");
        }
        // SessionMcpRuntime aggregates every upstream resources/list page, so
        // callers receive the complete list and no nextCursor is exposed.
        const resources = await runtime.listResources(view.serverName);
        return Array.isArray(resources) ? { resources } : resources;
      }
      case "resources/templates/list":
        if (!runtime.listResourceTemplates) {
          throw new Error("MCP resources/templates/list is unavailable");
        }
        return await runtime.listResourceTemplates(
          view.serverName,
          operation.params?.cursor ? { cursor: operation.params.cursor } : undefined,
        );
      case "resources/read":
        if (!runtime.readResource) {
          throw new Error("MCP resources/read is unavailable");
        }
        return await runtime.readResource(view.serverName, operation.params.uri);
      default: {
        const unsupported: never = operation;
        throw new Error(`Unsupported MCP App operation: ${String(unsupported)}`);
      }
    }
  });
}

export function parseMcpAppOperation(value: unknown): McpAppOperation | undefined {
  const method = asOptionalRecord(value)?.method;
  const schema =
    method === "tools/call"
      ? CallToolRequestSchema
      : method === "tools/list"
        ? ListToolsRequestSchema
        : method === "resources/list"
          ? ListResourcesRequestSchema
          : method === "resources/templates/list"
            ? ListResourceTemplatesRequestSchema
            : method === "resources/read"
              ? ReadResourceRequestSchema
              : undefined;
  if (!schema) {
    return undefined;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? (parsed.data as McpAppOperation) : undefined;
}

/** The current UI request owns approval/question delivery; upstream server callbacks retain that scope. */
export async function callMcpAppToolWithElicitation(params: {
  options: GatewayRequestHandlerOptions;
  origin: McpAppFormOrigin;
  toolName: string;
  input: Record<string, unknown>;
  assertCurrent: () => void;
  signal?: AbortSignal;
  uploadResources?: McpFormResourceUpload;
  _meta?: Record<string, unknown>;
}) {
  const signals = [params.options.signal, params.signal, getSessionMcpRequestSignal()].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length ? AbortSignal.any(signals) : new AbortController().signal;
  const assertCurrent = () => {
    signal.throwIfAborted();
    params.assertCurrent();
    params.origin.assertCurrent();
  };
  assertCurrent();
  const questions = new Map<string, import("./question-manager.js").QuestionObservation>();
  const retireQuestions = () => {
    const manager = params.options.context.questionManager;
    for (const [id, observation] of questions) {
      try {
        if (manager && observation.isCurrent() && observation.record.status === "pending") {
          manager.cancel(id, "mcp-app-request-retired");
        }
      } catch (error) {
        logWarn(`mcp-app: question cleanup failed: ${formatErrorMessage(error)}`);
      }
      questions.delete(id);
    }
  };
  signal.addEventListener("abort", retireQuestions, { once: true });
  const gatewayCall: import("../agents/harness/gateway-question-dispatch.js").AgentQuestionDispatcher =
    {
      version: 2,
      call: async ({ method, params: requestParams, signal: requestSignal, authority }) => {
        const assertDispatchCurrent = () => {
          assertCurrent();
          if (authority.kind === "source-bound") {
            authority.assertCurrent();
          }
        };
        assertDispatchCurrent();
        const { handleGatewayRequest } = await import("./server-methods.js");
        assertDispatchCurrent();
        return await new Promise<unknown>((resolve, reject) => {
          void handleGatewayRequest({
            req: { type: "req", id: randomUUID(), method, params: requestParams },
            client: params.options.client,
            context: params.options.context,
            methodRegistry: params.options.context.getGatewayMethodRegistry?.(),
            isWebchatConnect: params.options.isWebchatConnect,
            signal: requestSignal ?? signal,
            sessionMutationCommitGuard: assertDispatchCurrent,
            hasCurrentClientAuthority: params.options.hasCurrentClientAuthority,
            respond: (ok, result, error) => {
              if (!ok) {
                reject(new Error(error?.message ?? "App question request failed"));
                return;
              }
              if (method === "question.request") {
                const id = asOptionalRecord(result)?.id;
                const observation =
                  typeof id === "string"
                    ? params.options.context.questionManager?.observe(id)
                    : undefined;
                if (observation && typeof id === "string") {
                  questions.set(id, observation);
                  if (signal.aborted) {
                    retireQuestions();
                  }
                }
              }
              resolve(result);
            },
          }).catch(reject);
        });
      },
    };
  const handler = createMcpClientElicitationHandler({
    sessionKey: params.origin.sessionKey,
    agentId: params.origin.agentId,
    assertCurrent,
    gatewayCall,
    prepareResourceContext: async (request) => {
      const { createMcpAppFormResourceContext } = await import("./mcp-app-form-resources.js");
      assertCurrent();
      return createMcpAppFormResourceContext({
        snapshot: request.snapshot,
        signal: request.signal,
        origin: params.origin,
        uploadResources: params.uploadResources,
      });
    },
  });
  try {
    return await runWithSessionMcpRequestSignal(signal, () =>
      runWithMcpElicitationHandler(handler, () =>
        params.origin.runtime.callTool(params.origin.serverName, params.toolName, params.input, {
          ...(params._meta ? { _meta: params._meta } : {}),
          assertCurrent,
        }),
      ),
    );
  } finally {
    signal.removeEventListener("abort", retireQuestions);
    retireQuestions();
  }
}
