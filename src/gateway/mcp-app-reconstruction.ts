import type { BoardMcpAppDescriptor } from "../../packages/gateway-protocol/src/index.js";
import { acquireSessionMcpRuntime } from "../agents/agent-bundle-mcp-manager-api.js";
import { releaseSessionMcpRuntime } from "../agents/agent-bundle-mcp-manager-cleanup.js";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  fetchMcpAppView,
  getMcpAppViewLease,
  releaseMcpAppView,
  type McpAppViewLease,
} from "../agents/mcp-ui-resource.js";
import { captureSessionEntryMetadataRead } from "../config/sessions/session-entry-source-authority.js";
import { captureIncognitoSessionSource } from "../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import type { McpAppTranscriptLookup } from "./mcp-app-transcript.js";
import { readSessionTranscriptSummaryAsync } from "./session-transcript-readers.js";
import { withGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";
import type { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

const MCP_APP_RESTORE_IN_FLIGHT_KEY = Symbol.for("openclaw.mcpAppRestoreInFlight");

type ReconstructionResult = {
  runtime: SessionMcpRuntime;
  view: McpAppViewLease;
};

async function reconstructMcpAppView(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  lookup: McpAppTranscriptLookup;
  allowedAppToolNames: ReadonlySet<string>;
  authorizeAppInteraction?: () => boolean | Promise<boolean>;
  readOnly: boolean;
  viewId?: string;
}): Promise<ReconstructionResult | undefined> {
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  const metadata = captureSessionEntryMetadataRead({ sessionKey: params.sessionKey, agentId });
  const reconstruct = async (
    loaded: ReturnType<typeof loadGatewaySessionEntryReadOnly>,
    assertCurrent: () => void,
  ): Promise<ReconstructionResult | undefined> => {
    const sessionId = loaded.entry?.sessionId;
    if (!sessionId) {
      return undefined;
    }
    const transcriptScope = {
      agentId,
      sessionId,
      sessionKey: loaded.canonicalKey,
      storePath: loaded.storePath,
      sessionEntry: loaded.entry,
    };
    const { data } = await readSessionTranscriptSummaryAsync(transcriptScope, {
      kind: "mcp-app",
      lookup: params.lookup,
    });
    assertCurrent();
    if (!data) {
      return undefined;
    }
    const acquisition = await acquireSessionMcpRuntime({
      sessionId,
      sessionKey: loaded.canonicalKey,
      workspaceDir: resolveAgentWorkspaceDir(params.cfg, agentId),
      agentDir: resolveAgentDir(params.cfg, agentId),
      cfg: params.cfg,
    });
    const { runtime } = acquisition;
    try {
      assertCurrent();
      if (runtime.mcpAppsEnabled !== true) {
        return undefined;
      }
      const fetched = await fetchMcpAppView({
        runtime,
        agentId,
        serverName: data.descriptor.serverName,
        toolName: data.descriptor.toolName,
        uiResourceUri: data.descriptor.uiResourceUri,
        toolCallId: data.descriptor.toolCallId,
        toolInput: data.toolInput,
        toolResult: data.toolResult,
        ...(params.viewId ? { viewId: params.viewId } : {}),
        allowedAppToolNames: params.allowedAppToolNames,
        ...(metadata
          ? {
              authorizeAppInteraction: () => {
                assertCurrent();
                const allowed = params.authorizeAppInteraction?.() ?? true;
                return allowed instanceof Promise
                  ? allowed.then((value) => {
                      assertCurrent();
                      return value;
                    })
                  : allowed;
              },
            }
          : params.authorizeAppInteraction
            ? { authorizeAppInteraction: params.authorizeAppInteraction }
            : {}),
        ...(params.readOnly ? { readOnly: true as const } : {}),
      });
      try {
        assertCurrent();
      } catch (error) {
        if (fetched) {
          releaseMcpAppView(fetched.viewId, runtime);
        }
        throw error;
      }
      const view = fetched ? getMcpAppViewLease(fetched.viewId, runtime) : undefined;
      return view ? { runtime, view } : undefined;
    } finally {
      await releaseSessionMcpRuntime(acquisition);
    }
  };
  if (metadata) {
    return withGatewaySessionEntryReadOnly(
      { cfg: params.cfg, key: params.sessionKey, agentId },
      async (loaded, assertSourceCurrent) => {
        const assertCurrent = () => {
          assertSourceCurrent();
          const current = metadata.readCurrent();
          if (
            current?.sessionId !== loaded.entry?.sessionId ||
            current?.lifecycleRevision !== loaded.entry?.lifecycleRevision ||
            current?.archivedAt !== loaded.entry?.archivedAt
          ) {
            throw new Error("MCP App reconstruction session changed");
          }
        };
        const result = await reconstruct(loaded, assertCurrent);
        try {
          assertCurrent();
        } catch (error) {
          if (result) {
            releaseMcpAppView(result.view.viewId, result.runtime);
          }
          throw error;
        }
        return result;
      },
    );
  }
  return withGatewaySessionEntryReadOnly(
    { cfg: params.cfg, key: params.sessionKey, agentId },
    reconstruct,
  );
}

export async function mintMcpAppViewFromTranscript(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  descriptor: BoardMcpAppDescriptor;
  allowedAppToolNames: ReadonlySet<string>;
  authorizeAppInteraction?: () => boolean | Promise<boolean>;
  readOnly: boolean;
}): Promise<ReconstructionResult | undefined> {
  const { descriptor, ...request } = params;
  return await reconstructMcpAppView({
    ...request,
    lookup: { descriptor },
  });
}

export async function restoreMcpAppView(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey: string;
  viewId: string;
}): Promise<ReconstructionResult | undefined> {
  const source = captureIncognitoSessionSource(params);
  const sourceId = source
    ? "kind" in source
      ? `absent:${source.path}`
      : source.actor.identity.incarnation
    : "native";
  const key = `${params.agentId ?? ""}\0${params.sessionKey}\0${params.viewId}\0${sourceId}`;
  const inFlight = resolveGlobalMap<string, Promise<ReconstructionResult | undefined>>(
    MCP_APP_RESTORE_IN_FLIGHT_KEY,
  );
  const result = await getOrCreatePromise(
    inFlight,
    key,
    async () => {
      if (!params.viewId.startsWith("mcp-app-") || params.viewId.length > 128) {
        return undefined;
      }
      return reconstructMcpAppView({
        ...params,
        lookup: { viewId: params.viewId },
        // Restored previews need a fresh run grant before they can call tools.
        allowedAppToolNames: new Set(),
        readOnly: true,
      });
    },
    { evictOnSettled: true },
  );
  if (source) {
    if ("kind" in source) {
      source.assertCurrent();
    } else {
      source.actor.assertReadable();
    }
  }
  return result;
}
