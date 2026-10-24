/** Process-lifetime MCP clients owned by the headless node host. */
import { isDeepStrictEqual } from "node:util";
import { Client, SdkErrorCode, type Tool } from "@modelcontextprotocol/client";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import pLimit from "p-limit";
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
import { listAllMcpTools } from "../agents/mcp-catalog-listing.js";
import {
  connectMcpClient,
  disposeMcpClient,
  isMcpHttpSessionExpired,
} from "../agents/mcp-client-lifecycle.js";
import { redactMcpDiagnosticError } from "../agents/mcp-error.js";
import { createMcpJsonSchemaValidator } from "../agents/mcp-json-schema-validator.js";
import { sanitizeMcpMetadataText } from "../agents/mcp-metadata.js";
import {
  McpSdkCompatibilityError,
  mcpCallToolResultSchema,
} from "../agents/mcp-sdk-compatibility.js";
import { isMcpToolAllowed } from "../agents/mcp-tool-filter.js";
import {
  normalizeMcpToolCatalog,
  type McpToolCatalogMetadata,
} from "../agents/mcp-tool-metadata.js";
import { resolveMcpRequestTimeoutMs } from "../agents/mcp-transport-config.js";
import { resolveMcpTransport } from "../agents/mcp-transport.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import {
  NODE_MCP_TOOL_CALL_TIMEOUT_MS,
  NODE_MCP_TOOLS_CALL_COMMAND,
} from "../infra/node-commands.js";
import { VERSION } from "../version.js";

const NODE_MCP_PLUGIN_ID = "node-mcp";
const NODE_MCP_DESCRIPTION_MAX_CHARS = 1_024;
const NODE_MCP_NAME_MAX_CHARS = 64;
const NODE_MCP_SERVER_FRAGMENT_MAX_CHARS = 31;
const NODE_MCP_ERROR_MAX_CHARS = 1_024;
const NODE_MCP_MAX_DESCRIPTORS = 128;
const NODE_MCP_MAX_DESCRIPTOR_BYTES = 1024 * 1024;
const NODE_MCP_MAX_CATALOG_BYTES = 10 * 1024 * 1024;
const NODE_MCP_CONNECT_CONCURRENCY = 6;
const NODE_MCP_RETRY_INITIAL_MS = 250;
const NODE_MCP_RETRY_MAX_MS = 60_000;

type NodeHostMcpTransport = Pick<
  NonNullable<ReturnType<typeof resolveMcpTransport>>,
  "transport" | "transportType" | "connectionTimeoutMs" | "requestTimeoutMs" | "detachStderr"
>;

type NodeHostMcpSession = NodeHostMcpTransport & {
  client: Client;
  connected: boolean;
  toolCallTimeoutMs: number;
  abortController: AbortController;
  toolMetadata?: McpToolCatalogMetadata;
};

type NodeHostMcpServerState = {
  serverName: string;
  config: McpServerConfig;
  current?: NodeHostMcpSession;
  listedTools: Tool[];
  work: Promise<void>;
  catalogWork: Promise<void>;
  refreshQueued: boolean;
  retryDelayMs: number;
  retryTimer?: ReturnType<typeof setTimeout>;
};

type NodeHostMcpErrorCode =
  | "MCP_SERVER_UNAVAILABLE"
  | "MCP_TOOL_UNAVAILABLE"
  | "MCP_TOOL_TIMEOUT"
  | "MCP_TOOL_ERROR";

export class NodeHostMcpError extends Error {
  readonly code: NodeHostMcpErrorCode;

  constructor(code: NodeHostMcpErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NodeHostMcpError";
    this.code = code;
  }
}

export type NodeHostMcpManager = Awaited<ReturnType<typeof startNodeHostMcpManager>>;

type NodeHostMcpManagerDeps = {
  onDescriptorsChanged?: () => void;
  signal?: AbortSignal;
};

function formatMcpError(error: unknown): string {
  return truncateUtf16Safe(redactMcpDiagnosticError(error), NODE_MCP_ERROR_MAX_CHARS);
}

function sanitizeDescriptorFragment(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  const normalized = cleaned || fallback;
  return /^[A-Za-z]/.test(normalized) ? normalized : `${fallback}_${normalized}`;
}

function buildDescriptorBaseName(serverName: string, toolName: string): string {
  const server = sanitizeDescriptorFragment(serverName, "mcp").slice(
    0,
    NODE_MCP_SERVER_FRAGMENT_MAX_CHARS,
  );
  const toolBudget = Math.max(1, NODE_MCP_NAME_MAX_CHARS - server.length - 1);
  const tool = sanitizeDescriptorFragment(toolName, "tool").slice(0, toolBudget);
  return `${server}_${tool}`;
}

function reserveDescriptorName(baseName: string, usedNames: Set<string>): string {
  let index = 1;
  while (true) {
    const suffix = index === 1 ? "" : `_${index}`;
    const candidate = `${baseName.slice(0, NODE_MCP_NAME_MAX_CHARS - suffix.length)}${suffix}`;
    const key = normalizeLowercaseStringOrEmpty(candidate);
    if (!usedNames.has(key)) {
      usedNames.add(key);
      return candidate;
    }
    index += 1;
  }
}

/** Builds provider-safe MCP descriptors in stable server/tool order. */
function buildNodeMcpToolDescriptors(
  listedTools: ReadonlyArray<{ serverName: string; tool: Tool }>,
): NodePluginToolDescriptor[] {
  const usedNames = new Set<string>();
  const descriptors: NodePluginToolDescriptor[] = [];
  let catalogBytes = 0;
  for (const { serverName, tool } of listedTools.toSorted(
    (left, right) =>
      left.serverName.localeCompare(right.serverName) ||
      left.tool.name.localeCompare(right.tool.name),
  )) {
    const toolName = tool.name.trim();
    const descriptor: NodePluginToolDescriptor = {
      pluginId: NODE_MCP_PLUGIN_ID,
      name: reserveDescriptorName(buildDescriptorBaseName(serverName, toolName), usedNames),
      description: truncateUtf16Safe(
        sanitizeMcpMetadataText(tool.description) ||
          sanitizeMcpMetadataText(toolName) ||
          "MCP tool",
        NODE_MCP_DESCRIPTION_MAX_CHARS,
      ),
      parameters: asOptionalRecord(tool.inputSchema) ?? {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
      command: NODE_MCP_TOOLS_CALL_COMMAND,
      mcp: { server: serverName, tool: toolName },
    };
    const descriptorBytes = Buffer.byteLength(JSON.stringify(descriptor));
    if (
      descriptorBytes > NODE_MCP_MAX_DESCRIPTOR_BYTES ||
      catalogBytes + descriptorBytes > NODE_MCP_MAX_CATALOG_BYTES
    ) {
      continue;
    }
    descriptors.push(descriptor);
    catalogBytes += descriptorBytes;
    if (descriptors.length >= NODE_MCP_MAX_DESCRIPTORS) {
      break;
    }
  }
  return descriptors;
}

async function disposeNodeHostMcpSession(
  serverName: string,
  session: NodeHostMcpSession,
): Promise<void> {
  session.abortController.abort(new Error("node host MCP session retired"));
  if ((await disposeMcpClient(session)) === "uncertain") {
    console.warn(
      `node host MCP server "${serverName}" cleanup could not be confirmed; check the server process`,
    );
  }
}

/** Starts process-lifetime MCP server state for the node host. */
export async function startNodeHostMcpManager(
  servers: Record<string, McpServerConfig> | undefined,
  deps: NodeHostMcpManagerDeps = {},
) {
  const descriptors: NodePluginToolDescriptor[] = [];
  const connectionAdmission = pLimit(NODE_MCP_CONNECT_CONCURRENCY);
  const lifecycleAbortController = new AbortController();
  const lifecycleSignal = deps.signal
    ? AbortSignal.any([deps.signal, lifecycleAbortController.signal])
    : lifecycleAbortController.signal;
  const states = new Map<string, NodeHostMcpServerState>(
    listEnabledNodeHostMcpServers(servers).map(([serverName, config]) => [
      serverName,
      {
        serverName,
        config,
        listedTools: [],
        work: Promise.resolve(),
        catalogWork: Promise.resolve(),
        refreshQueued: false,
        retryDelayMs: NODE_MCP_RETRY_INITIAL_MS,
      },
    ]),
  );
  let closed = false;
  let startupComplete = false;

  const rebuildDescriptors = () => {
    if (closed) {
      return;
    }
    const listedTools = Array.from(states.values()).flatMap((state) =>
      state.listedTools.map((tool) => ({ serverName: state.serverName, tool })),
    );
    const next = buildNodeMcpToolDescriptors(listedTools);
    if (next.length < listedTools.length) {
      console.warn(
        `node host MCP catalog bounded: published ${next.length} of ${listedTools.length} tools`,
      );
    }
    if (isDeepStrictEqual(descriptors, next)) {
      return;
    }
    descriptors.splice(0, descriptors.length, ...next);
    if (startupComplete) {
      deps.onDescriptorsChanged?.();
    }
  };

  const invalidateCurrent = (
    state: NodeHostMcpServerState,
    session: NodeHostMcpSession,
  ): boolean => {
    if (state.current !== session) {
      return false;
    }
    state.current = undefined;
    session.abortController.abort(new Error("node host MCP session invalidated"));
    state.listedTools = [];
    rebuildDescriptors();
    return true;
  };

  const enqueueWork = (state: NodeHostMcpServerState, task: () => Promise<void>): void => {
    state.work = state.work.then(task, task).catch(() => {});
  };

  const enqueueCatalogWork = (
    state: NodeHostMcpServerState,
    task: () => Promise<void>,
  ): Promise<void> => {
    const work = state.catalogWork.then(task, task);
    state.catalogWork = work.catch(() => {});
    return work;
  };

  const scheduleRetry = (state: NodeHostMcpServerState): void => {
    if (closed || lifecycleSignal.aborted || state.retryTimer || state.current) {
      return;
    }
    const delayMs = state.retryDelayMs;
    state.retryDelayMs = Math.min(delayMs * 2, NODE_MCP_RETRY_MAX_MS);
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined;
      enqueueWork(state, () => reconnect(state));
    }, delayMs);
    state.retryTimer.unref?.();
  };

  const updateCatalog = async (
    state: NodeHostMcpServerState,
    session: NodeHostMcpSession,
    signal: AbortSignal,
    resetRetryDelay = false,
  ) => {
    const normalized = await listAllMcpTools(session.client, session.requestTimeoutMs, signal).then(
      (tools) =>
        normalizeMcpToolCatalog(tools, createMcpJsonSchemaValidator(), (toolName) =>
          isMcpToolAllowed(state.config.toolFilter, toolName) ? "include" : "exclude",
        ),
    );
    if (closed || state.current !== session) {
      return;
    }
    session.toolMetadata = normalized.metadata;
    state.listedTools = normalized.tools;
    if (resetRetryDelay) {
      state.retryDelayMs = NODE_MCP_RETRY_INITIAL_MS;
    }
    rebuildDescriptors();
  };

  const connectAndList = (state: NodeHostMcpServerState, signal: AbortSignal): Promise<void> =>
    connectionAdmission(async () => {
      // Admission rechecks lifecycle so close can drain queued work without
      // creating a late client or transport.
      if (closed || signal.aborted) {
        return;
      }
      let resolved: NodeHostMcpTransport | null | undefined;
      let session: NodeHostMcpSession | undefined;
      try {
        resolved = resolveMcpTransport(state.serverName, state.config);
        if (!resolved) {
          states.delete(state.serverName);
          throw new Error("invalid or unsupported transport");
        }
        let onToolsChanged = () => {};
        const client = new Client(
          { name: "openclaw-node-host", version: VERSION },
          {
            jsonSchemaValidator: createMcpJsonSchemaValidator(),
            versionNegotiation: { mode: "legacy" },
            listChanged: {
              tools: {
                autoRefresh: false,
                debounceMs: 0,
                onChanged: () => onToolsChanged(),
              },
            },
          },
        );
        const createdSession: NodeHostMcpSession = {
          ...resolved,
          client,
          connected: false,
          toolCallTimeoutMs: resolveMcpRequestTimeoutMs(
            state.config,
            NODE_MCP_TOOL_CALL_TIMEOUT_MS,
          ),
          abortController: new AbortController(),
        };
        onToolsChanged = () => {
          if (state.current === createdSession) {
            requestRefresh(state, createdSession);
          }
        };
        session = createdSession;
        state.current = createdSession;
        // MCP Client exposes callback properties rather than an EventTarget surface.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        client.onclose = () => {
          if (createdSession.connected && invalidateCurrent(state, createdSession)) {
            enqueueWork(state, async () => {
              await disposeNodeHostMcpSession(state.serverName, createdSession);
              scheduleRetry(state);
            });
          }
        };
        await connectMcpClient({
          client,
          transport: resolved.transport,
          timeoutMs: resolved.connectionTimeoutMs,
          signal,
        });
        if (closed || signal.aborted || state.current !== session) {
          return;
        }
        session.connected = true;
        const listSignal = AbortSignal.any([signal, session.abortController.signal]);
        await enqueueCatalogWork(state, () =>
          updateCatalog(state, createdSession, listSignal, true),
        );
        // A notification received during startup queues behind the initial list.
        // Wait for that refresh so the manager never publishes the older snapshot.
        await state.catalogWork;
      } catch (error) {
        const lostOwnership = session !== undefined && state.current !== session;
        if (session && state.current === session) {
          invalidateCurrent(state, session);
          await disposeNodeHostMcpSession(state.serverName, session);
        } else if (!session) {
          resolved?.detachStderr?.();
        }
        if (closed || signal.aborted || lostOwnership) {
          return;
        }
        throw error;
      }
    });

  async function reconnect(state: NodeHostMcpServerState): Promise<void> {
    if (closed || state.current) {
      return;
    }
    try {
      await connectAndList(state, lifecycleSignal);
    } catch (error) {
      if (!closed && !lifecycleSignal.aborted) {
        console.warn(
          `node host MCP server "${state.serverName}" reconnect failed: ${formatMcpError(error)}`,
        );
        scheduleRetry(state);
      }
    }
  }

  const refresh = async (state: NodeHostMcpServerState, session: NodeHostMcpSession) => {
    if (closed || state.current !== session || !session.connected) {
      return;
    }
    try {
      await updateCatalog(
        state,
        session,
        AbortSignal.any([lifecycleSignal, session.abortController.signal]),
      );
    } catch (error) {
      if (closed || lifecycleSignal.aborted || state.current !== session) {
        return;
      }
      console.warn(
        `node host MCP server "${state.serverName}" tool refresh failed: ${formatMcpError(error)}`,
      );
      invalidateCurrent(state, session);
      await disposeNodeHostMcpSession(state.serverName, session);
      scheduleRetry(state);
    }
  };

  function requestRefresh(state: NodeHostMcpServerState, session: NodeHostMcpSession): void {
    if (
      closed ||
      lifecycleSignal.aborted ||
      state.current !== session ||
      !session.connected ||
      state.refreshQueued
    ) {
      return;
    }
    state.refreshQueued = true;
    void enqueueCatalogWork(state, async () => {
      state.refreshQueued = false;
      await refresh(state, session);
    }).catch(() => {});
  }

  const tasks = Array.from(states.values(), (state) => async () => {
    if (state.config.auth === "oauth" || state.config.oauth) {
      states.delete(state.serverName);
      console.warn(`node host MCP server "${state.serverName}" skipped: OAuth is not supported`);
      return;
    }
    try {
      await connectAndList(state, lifecycleSignal);
    } catch (error) {
      if (!lifecycleSignal.aborted) {
        console.warn(`node host MCP server "${state.serverName}" failed: ${formatMcpError(error)}`);
      }
    }
  });
  await Promise.all(tasks.map((task) => task()));
  startupComplete = true;
  for (const state of states.values()) {
    if (!state.current) {
      scheduleRetry(state);
    }
  }

  return {
    descriptors,
    async callMcpTool(params: {
      server: string;
      tool: string;
      arguments?: Record<string, unknown>;
      timeoutMs?: number;
      signal?: AbortSignal;
    }) {
      const state = states.get(params.server);
      const session = state?.current;
      if (!state || !session?.connected) {
        throw new NodeHostMcpError(
          "MCP_SERVER_UNAVAILABLE",
          `MCP server "${params.server}" is unavailable`,
        );
      }
      const published = descriptors.some(
        (descriptor) =>
          descriptor.mcp?.server === params.server && descriptor.mcp.tool === params.tool,
      );
      if (!published) {
        throw new NodeHostMcpError(
          "MCP_TOOL_UNAVAILABLE",
          `MCP tool "${params.tool}" is unavailable on server "${params.server}"`,
        );
      }
      const requestedTimeoutMs =
        clampPositiveTimerTimeoutMs(params.timeoutMs) ?? NODE_MCP_TOOL_CALL_TIMEOUT_MS;
      const validateResult = session.toolMetadata?.validatorForCall(params.tool);
      try {
        const result = await session.client.request(
          {
            method: "tools/call",
            params: { name: params.tool, arguments: params.arguments ?? {} },
          },
          mcpCallToolResultSchema,
          {
            timeout: Math.min(requestedTimeoutMs, session.toolCallTimeoutMs),
            ...(params.signal ? { signal: params.signal } : {}),
          },
        );
        validateResult?.(result);
        return result;
      } catch (error) {
        if (error instanceof McpSdkCompatibilityError) {
          throw error;
        }
        const sessionExpired = isMcpHttpSessionExpired(session, error);
        if (sessionExpired && invalidateCurrent(state, session)) {
          enqueueWork(state, async () => {
            await disposeNodeHostMcpSession(state.serverName, session);
            scheduleRetry(state);
          });
        }
        if (!sessionExpired && (!session.connected || state.current !== session)) {
          throw new NodeHostMcpError(
            "MCP_SERVER_UNAVAILABLE",
            `MCP server "${params.server}" disconnected`,
            { cause: error },
          );
        }
        const cancelled = params.signal?.aborted === true;
        const message = truncateUtf16Safe(
          formatErrorMessage(cancelled ? params.signal?.reason : error),
          NODE_MCP_ERROR_MAX_CHARS,
        );
        if (
          !cancelled &&
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === SdkErrorCode.RequestTimeout
        ) {
          throw new NodeHostMcpError("MCP_TOOL_TIMEOUT", message, { cause: error });
        }
        throw new NodeHostMcpError("MCP_TOOL_ERROR", message, { cause: error });
      }
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      lifecycleAbortController.abort(new Error("node host MCP manager closed"));
      const closing = Array.from(states.values(), async (state) => {
        if (state.retryTimer) {
          clearTimeout(state.retryTimer);
          state.retryTimer = undefined;
        }
        const session = state.current;
        state.current = undefined;
        state.listedTools = [];
        if (session) {
          await disposeNodeHostMcpSession(state.serverName, session);
        }
        // Lifecycle work accepted before close may append catalog work. Drain it
        // first, then await the latest catalog tail before releasing ownership.
        await state.work;
        await state.catalogWork;
      });
      await Promise.allSettled(closing);
    },
  };
}

function listEnabledNodeHostMcpServers(
  servers: Record<string, McpServerConfig> | undefined,
): ReadonlyArray<readonly [string, McpServerConfig]> {
  return Object.entries(servers ?? {})
    .filter(
      ([serverName, config]) =>
        serverName.length > 0 && serverName === serverName.trim() && config.enabled !== false,
    )
    .toSorted(([left], [right]) => left.localeCompare(right));
}
