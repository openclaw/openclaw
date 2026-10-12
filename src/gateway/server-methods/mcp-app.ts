import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  GatewayErrorDetailCodes,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  getMcpAppModelContext,
  removeMcpAppModelContextItem,
  subscribeMcpAppModelContext,
  updateMcpAppModelContext,
} from "../../agents/mcp-app-model-context.js";
import { buildMcpAppSandboxPath } from "../../agents/mcp-app-sandbox.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { logWarn } from "../../logger.js";
import { createLazyRuntimeMethod } from "../../shared/lazy-runtime.js";
import {
  executeMcpAppOperation,
  resolveMcpAppRequesterId,
  McpAppViewExpiredError,
  type McpAppOperation,
  requireMcpAppInteraction,
  resolveMcpAppActiveView,
  withMcpAppActiveView,
} from "../mcp-app-operations.js";
import { createMcpAppStandaloneTicket } from "../mcp-app-standalone.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

const fileRuntime = () => import("../mcp-app-host-files.js");
const readMcpAppHostFile = createLazyRuntimeMethod(
  fileRuntime,
  (runtime) => runtime.readMcpAppHostFile,
);
const writeMcpAppHostFile = createLazyRuntimeMethod(
  fileRuntime,
  (runtime) => runtime.writeMcpAppHostFile,
);
const subscribeMcpAppHostFile = createLazyRuntimeMethod(
  fileRuntime,
  (runtime) => runtime.subscribeMcpAppHostFile,
);
const canOpenMcpAppFiles = createLazyRuntimeMethod(
  fileRuntime,
  (runtime) => runtime.canOpenMcpAppFiles,
);
const openMcpAppFile = createLazyRuntimeMethod(fileRuntime, (runtime) => runtime.openMcpAppFile);

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function optionalRecord(params: Record<string, unknown>, key: string) {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }
  const record = asOptionalRecord(value);
  if (!record) {
    throw new Error(`${key} must be an object`);
  }
  return record;
}

function optionalCursor(params: Record<string, unknown>): { cursor?: string } | undefined {
  const cursor = params.cursor;
  return typeof cursor === "string" ? { cursor } : undefined;
}

class McpAppRequestError extends Error {
  constructor(readonly shape: ReturnType<typeof errorShape>) {
    super(shape.message);
  }
}

function resolveMcpAppSessionOwner(params: Record<string, unknown>, cfg: OpenClawConfig): string {
  const sessionKey = requireString(params, "sessionKey");
  const explicitAgentId =
    typeof params.agentId === "string" && params.agentId.trim() ? params.agentId.trim() : undefined;
  const owner = resolveRequestedSessionAgentId(cfg, sessionKey, explicitAgentId);
  if (!owner.ok) {
    throw new McpAppRequestError(owner.error);
  }
  return owner.agentId;
}

function resolveRequestedMcpAppView(
  { params, context, client }: GatewayRequestHandlerOptions,
  prepared?: { cfg: OpenClawConfig; requesterId: string | undefined },
) {
  return resolveMcpAppActiveView({
    sessionKey: requireString(params, "sessionKey"),
    agentId: resolveMcpAppSessionOwner(params, prepared?.cfg ?? context.getRuntimeConfig()),
    viewId: requireString(params, "viewId"),
    requesterId: prepared ? prepared.requesterId : resolveMcpAppRequesterId(client),
    cfg: context.getRuntimeConfig(),
    restore: false,
  });
}

function operationHandler(
  buildOperation: (params: Record<string, unknown>) => McpAppOperation,
): GatewayRequestHandler {
  return mcpAppHandler(async (options) => {
    const { params, context, client } = options;
    const requestAuthority = readGatewayRequestMutationAuthority(options);
    const operation = buildOperation(params);
    const cfg = context.getRuntimeConfig();
    const requesterId = resolveMcpAppRequesterId(client);
    const active = await resolveRequestedMcpAppView(options, { cfg, requesterId });
    const read = retainSessionScopedRead(
      options,
      requireString(params, "sessionKey"),
      active.view.agentId,
    );
    try {
      const result =
        operation.method === "resources/read" && operation.params.uri.startsWith("openclaw-file://")
          ? await readMcpAppHostFile(options, active.view, operation.params)
          : await executeMcpAppOperation(active, operation, {
              options,
              assertCurrent: () => {
                requestAuthority.assertCurrent();
                read?.assertCurrent();
                options.sessionMutationAuthorization?.assertCurrent();
                if (
                  resolveMcpAppRequesterId(client) !== requesterId ||
                  (active.view.requesterId !== undefined && active.view.requesterId !== requesterId)
                ) {
                  throw new McpAppViewExpiredError();
                }
              },
            });
      read?.assertCurrent();
      return result;
    } finally {
      read?.release();
    }
  });
}

function mcpAppHandler(
  operation: (options: GatewayRequestHandlerOptions) => Promise<unknown>,
): GatewayRequestHandler {
  return async (options) => {
    try {
      options.respond(true, await operation(options));
    } catch (error) {
      options.respond(
        false,
        undefined,
        error instanceof McpAppRequestError
          ? error.shape
          : errorShape(
              ErrorCodes.UNAVAILABLE,
              formatErrorMessage(error),
              error instanceof McpAppViewExpiredError
                ? { details: { code: GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED } }
                : undefined,
            ),
      );
    }
  };
}

const modelContextSubscriptions = new WeakMap<object, Map<string, () => void>>();

function hostFileHandler(
  operation: (
    options: GatewayRequestHandlerOptions,
    view: import("../../agents/mcp-ui-resource.js").McpAppViewLease,
  ) => Promise<unknown>,
): GatewayRequestHandler {
  return mcpAppHandler(async (options) => {
    const active = await resolveRequestedMcpAppView(options);
    return withMcpAppActiveView(active, "read", () => operation(options, active.view));
  });
}

export const mcpAppHandlers: GatewayRequestHandlers = {
  "mcp.app.formResource": mcpAppHandler(async (options) => {
    const { executeMcpAppFormResource } = await import("../mcp-app-form-resources.js");
    return executeMcpAppFormResource(options);
  }),
  "mcp.app.view": mcpAppHandler(async (options) => {
    const { params, context, client } = options;
    const sessionKey = requireString(params, "sessionKey");
    const agentId = resolveMcpAppSessionOwner(params, context.getRuntimeConfig());
    const requesterId = resolveMcpAppRequesterId(client);
    const read = retainSessionScopedRead(options, sessionKey, agentId);
    const assertRequestCurrent = () => {
      read?.assertCurrent();
      if (requesterId !== resolveMcpAppRequesterId(client)) {
        throw new McpAppViewExpiredError();
      }
    };
    try {
      const active = await resolveMcpAppActiveView({
        sessionKey: requireString(params, "sessionKey"),
        agentId: resolveMcpAppSessionOwner(params, context.getRuntimeConfig()),
        viewId: requireString(params, "viewId"),
        requesterId: resolveMcpAppRequesterId(client),
        cfg: context.getRuntimeConfig(),
      });
      read?.assertCurrent();
      const payload = await withMcpAppActiveView(active, "read", async () => {
        const { view } = active;
        if (client?.connId) {
          const byConnection = modelContextSubscriptions.get(view) ?? new Map<string, () => void>();
          const previous = byConnection.get(client.connId);
          previous?.();
          if (previous) {
            view.disposeCallbacks?.delete(previous);
          }
          if (byConnection.size >= 32 && !byConnection.has(client.connId)) {
            throw new Error("MCP App connection limit reached");
          }
          const connId = client.connId;
          let updateId = getMcpAppModelContext(active.runtime, view)?.updateId;
          const unsubscribe = subscribeMcpAppModelContext(view, (state) => {
            const clearedUpdateId = updateId;
            updateId = state?.updateId;
            context.broadcastToConnIds(
              "mcp.app.hostContextChanged",
              {
                viewId: view.viewId,
                ...(state === null ? { modelContext: null, updateId: clearedUpdateId } : {}),
              },
              new Set([connId]),
            );
          });
          const stop = () => {
            unsubscribe();
            client.connectionSignal?.removeEventListener("abort", stop);
            if (byConnection.get(connId) === stop) {
              byConnection.delete(connId);
            }
            view.disposeCallbacks?.delete(stop);
          };
          client.connectionSignal?.addEventListener("abort", stop, { once: true });
          byConnection.set(connId, stop);
          modelContextSubscriptions.set(view, byConnection);
          view.disposeCallbacks ??= new Set();
          view.disposeCallbacks.add(stop);
          if (client.connectionSignal?.aborted) {
            stop();
          }
        }
        let interactive = false;
        try {
          await requireMcpAppInteraction(view);
          interactive = true;
        } catch {
          // Stale board leases remain renderable but lose every interactive capability.
        }
        const openFilesSupported =
          interactive && Boolean(active.runtime.sessionKey) && (await canOpenMcpAppFiles(view));
        const updateModelContextSupported =
          interactive &&
          Boolean(active.runtime.sessionKey) &&
          active.runtime.mcpAppModelContextRevoked !== true;
        const sandboxPort =
          context.getMcpAppSandboxPort?.() ?? (await context.ensureSandboxHostPort?.());
        if (sandboxPort === undefined) {
          throw new Error("MCP App sandbox listener is unavailable; restart the Gateway");
        }
        const configuredOrigin = context.getRuntimeConfig().mcp?.apps?.sandboxOrigin;
        let standalone: ReturnType<typeof createMcpAppStandaloneTicket> = undefined;
        try {
          standalone = createMcpAppStandaloneTicket({
            sessionKey: requireString(params, "sessionKey"),
            view,
            toolOperationsAuthorized: authorizeOperatorScopesForMethod(
              "mcp.app.callTool",
              client?.connect?.scopes ?? [],
            ).allowed,
          });
        } catch (error) {
          // Standalone links are additive; issuance must never break the
          // existing authenticated Control UI view payload.
          logWarn(`mcp-app: standalone ticket unavailable: ${formatErrorMessage(error)}`);
        }
        assertRequestCurrent();
        return {
          sandboxUrl: buildMcpAppSandboxPath(view.csp),
          sandboxPort,
          ...(configuredOrigin ? { sandboxOrigin: new URL(configuredOrigin).origin } : {}),
          html: view.html,
          ...(view.csp ? { csp: view.csp } : {}),
          toolInput: view.toolInput,
          toolResult: view.toolResult,
          hostContext: {
            "openai/modelContext": getMcpAppModelContext(active.runtime, view),
            ...(view.deepLink ? { "openai/deepLink": view.deepLink } : {}),
          },
          ...(view.displayModes ? { displayModes: view.displayModes } : {}),
          ...(view.displayMode ? { displayMode: view.displayMode } : {}),
          richModelContextSupported:
            updateModelContextSupported && view.richModelContextSupported !== false,
          fileResourcesSupported: interactive && Boolean(view.hostFile),
          openFilesSupported,
          ...(standalone
            ? {
                standaloneUrl: standalone.url,
                standaloneExpiresAtMs: standalone.expiresAtMs,
              }
            : {}),
          // Reconstruction marks views read-only; fresh runs may legitimately grant zero App tools.
          messageSupported: interactive,
          updateModelContextSupported,
        };
      });
      assertRequestCurrent();
      return payload;
    } finally {
      read?.release();
    }
  }),
  "mcp.app.updateModelContext": mcpAppHandler(async (options) => {
    const { params } = options;
    const active = await resolveRequestedMcpAppView(options);
    return await withMcpAppActiveView(active, "read", async () => {
      await requireMcpAppInteraction(active.view);
      return updateMcpAppModelContext(active.runtime, active.view, params);
    });
  }),
  "mcp.app.modelContext": mcpAppHandler(async (options) => {
    const active = await resolveRequestedMcpAppView(options);
    await requireMcpAppInteraction(active.view);
    return { state: getMcpAppModelContext(active.runtime, active.view) };
  }),
  "mcp.app.removeModelContext": mcpAppHandler(async (options) => {
    const { params } = options;
    const active = await resolveRequestedMcpAppView(options);
    await requireMcpAppInteraction(active.view);
    if (params.index !== undefined && typeof params.index !== "number") {
      throw new Error("index must be a number");
    }
    return {
      state: removeMcpAppModelContextItem(
        active.runtime,
        active.view,
        requireString(params, "updateId"),
        params.index,
      ),
    };
  }),
  "mcp.app.writeResource": hostFileHandler((options, view) =>
    writeMcpAppHostFile(options, view, options.params),
  ),
  "mcp.app.subscribeResource": hostFileHandler((options, view) =>
    subscribeMcpAppHostFile(options, view, requireString(options.params, "uri"), true),
  ),
  "mcp.app.unsubscribeResource": hostFileHandler((options, view) =>
    subscribeMcpAppHostFile(options, view, requireString(options.params, "uri"), false),
  ),
  "mcp.app.openFile": hostFileHandler((options, view) =>
    openMcpAppFile(options, view, requireString(options.params, "path")),
  ),
  "mcp.app.callTool": operationHandler((params) => ({
    method: "tools/call",
    params: {
      name: requireString(params, "toolName"),
      arguments: optionalRecord(params, "arguments") ?? {},
    },
  })),
  "mcp.app.listTools": operationHandler((params) => ({
    method: "tools/list",
    params: optionalCursor(params) ?? {},
  })),
  "mcp.app.listResources": operationHandler((params) => ({
    method: "resources/list",
    params: optionalCursor(params) ?? {},
  })),
  "mcp.app.listResourceTemplates": operationHandler((params) => ({
    method: "resources/templates/list",
    params: optionalCursor(params) ?? {},
  })),
  "mcp.app.readResource": operationHandler((params) => ({
    method: "resources/read",
    params: {
      uri: requireString(params, "uri"),
      _meta: optionalRecord(params, "_meta"),
    },
  })),
};
