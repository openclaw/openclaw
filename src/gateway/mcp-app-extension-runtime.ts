import { acquireSessionMcpRuntime } from "../agents/agent-bundle-mcp-manager-api.js";
import { releaseSessionMcpRuntime } from "../agents/agent-bundle-mcp-manager-cleanup.js";
import { buildBundleMcpToolsFromCatalog } from "../agents/agent-bundle-mcp-materialize.js";
import { loadSessionMcpConfig } from "../agents/agent-bundle-mcp-runtime-config.js";
import type { McpCatalogTool, SessionMcpRuntimeLease } from "../agents/agent-bundle-mcp-types.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import type { prepareAgentHarnessSessionRuntime } from "../agents/harness/session-preparation.js";
import {
  requiresMcpCodexToolApproval,
  resolveProjectedMcpCodexToolApprovalMode,
} from "../agents/mcp-codex-tool-approval.js";
import { isMcpToolAllowed, normalizeMcpToolFilter } from "../agents/mcp-tool-filter.js";
import type { McpAppPrepareToolCall } from "../agents/mcp-ui-resource.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { resolveSessionPinnedHarnessId } from "../sessions/agent-harness-session-key.js";
import { resolveMcpAppRequesterId } from "./mcp-app-host-files.js";
import { requestMcpAppToolApproval } from "./mcp-app-tool-approval.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { resolveSessionResourceToolPolicy } from "./session-resource-tool-policy.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { resolveSessionSelectedModelRef } from "./session-utils-model-selection.js";

function runtimeSelection(
  entry: SessionEntry,
  model: { provider: string; model: string },
  harnessId: string,
) {
  return JSON.stringify([
    resolveSessionPinnedHarnessId(entry),
    model.provider,
    model.model,
    harnessId,
    entry.agentRuntimeOverride,
    entry.modelSelectionLocked,
    entry.providerOverride,
    entry.modelOverride,
    entry.authProfileOverride,
    entry.authProfileOverrideSource,
    entry.sandboxMode,
  ]);
}

/** A request borrows the current owner; it never substitutes a different native transport. */
export async function prepareMcpAppExtensionRuntime(options: GatewayRequestHandlerOptions) {
  const access = options.sessionAccessAuthority;
  const projection = getSessionRowProjection(options.context);
  if (!access || !projection) {
    throw new Error("MCP App session authority is unavailable");
  }
  access.assertCurrent();
  const { agentId, sessionKey, sessionId } = access.target;
  const query = { agentId, key: sessionKey };
  const initial = projection.sharingTarget(query);
  if (!initial || initial.entry.sessionId !== sessionId) {
    throw new Error("MCP App session changed");
  }
  const cfg = options.context.getRuntimeConfig();
  if (cfg.mcp?.apps?.enabled !== true) {
    throw new Error("MCP Apps are disabled");
  }
  const selectRuntime = (entry: SessionEntry) => {
    const model = resolveSessionSelectedModelRef({
      cfg,
      agentId,
      sessionKey,
      source: {
        entry,
        readSourceEntry: (key) => projection.sharingTarget({ agentId, key })?.entry,
      },
      manifestPlugins: getGatewayPluginMetadataSnapshot() ?? [],
    });
    const harnessId = resolveEffectiveAgentRuntime({
      cfg,
      provider: model.provider,
      modelId: model.model,
      agentScope: { kind: "prepared", agentId },
      sessionKey,
      sessionEntry: entry,
    });
    return { model, harnessId, fingerprint: runtimeSelection(entry, model, harnessId) };
  };
  // Last-turn model/harness observations do not change the selected owner.
  // Resolve inherited choices from the same prepared facts used at launch.
  const selected = selectRuntime(initial.entry);
  const current = (assertAccess = access.assertCurrent) => {
    assertAccess();
    if (options.context.getRuntimeConfig() !== cfg) {
      throw new Error("MCP App configuration changed; reopen the App");
    }
    const target = projection.sharingTarget(query);
    if (!target || target.entry.sessionId !== sessionId) {
      throw new Error("MCP App session changed");
    }
    if (selectRuntime(target.entry).fingerprint !== selected.fingerprint) {
      throw new Error("MCP App session runtime selection changed; reopen the App");
    }
    return target;
  };
  const target = current();
  const workspaceDir = target.entry.spawnedWorkspaceDir ?? resolveAgentWorkspaceDir(cfg, agentId);
  const requesterId = resolveMcpAppRequesterId(options.client);
  const { model: selectedModel, harnessId } = selected;
  const registered = harnessId ? getRegisteredAgentHarness(harnessId) : undefined;
  if (harnessId !== "openclaw" && !registered) {
    throw new Error("The selected session harness is unavailable");
  }
  const harness = registered?.harness;
  const { loaded } = loadSessionMcpConfig({
    workspaceDir,
    cfg,
    toolOverrides: target.entry.toolOverrides,
  });
  let lease: SessionMcpRuntimeLease | undefined;
  if (harnessId !== "openclaw") {
    if (!harness?.loadMcpToolCatalog || !harness.acquireMcpAppRuntime) {
      throw new Error("The session harness cannot open MCP Apps");
    }
    const preparationOwner: {
      access?: ReturnType<typeof access.retain>;
      setup?: Awaited<ReturnType<typeof prepareAgentHarnessSessionRuntime>>;
      source?: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
    } = {};
    let preparing:
      | Promise<import("../agents/harness/types.js").AgentHarnessSessionPreparationV1>
      | undefined;
    const prepareSession = () => {
      preparing ??= (async () => {
        current();
        const isolation = resolveSandboxRuntimeStatus({
          cfg,
          agentId,
          sessionKey,
          preparedSessionEntry: current().entry,
        });
        if (access.sandboxRequired || isolation.sandboxed || isolation.sandboxRequired) {
          throw new Error(
            "Native App initialization cannot run outside required session isolation",
          );
        }
        if (!registered?.ownerPluginId) {
          throw new Error("Native harness owner is unavailable");
        }
        const retained = access.retain();
        preparationOwner.access = retained;
        const signal = options.signal
          ? AbortSignal.any([retained.signal, options.signal])
          : retained.signal;
        const assertPreparationCurrent = () => {
          current();
          retained.assertCurrent();
          signal.throwIfAborted();
        };
        assertPreparationCurrent();
        const source = await captureGatewayOperatorRunAuthority({
          client: options.client,
          context: options.context,
          hasCurrentClientAuthority: options.hasCurrentClientAuthority,
          invocationAuthority: { assertCurrent: assertPreparationCurrent, signal },
        });
        preparationOwner.source = source;
        assertPreparationCurrent();
        const live = current();
        const { prepareAgentHarnessSessionRuntime } =
          await import("../agents/harness/session-preparation.js");
        const setup = await prepareAgentHarnessSessionRuntime({
          ownerPluginId: registered.ownerPluginId,
          nativeModelPolicySupport: harness.nativeModelPolicySupport,
          sourceAuthority: source?.authority,
          assertCurrent: assertPreparationCurrent,
          input: {
            config: cfg,
            agentId,
            agentDir: resolveAgentDir(cfg, agentId),
            sessionId,
            sessionKey,
            workspaceDir,
            provider: selectedModel.provider,
            modelId: selectedModel.model,
            authProfileId: live.entry.authProfileOverride,
            authProfileIdSource:
              live.entry.authProfileOverrideSource === "auto"
                ? "auto"
                : live.entry.authProfileOverride
                  ? "user"
                  : undefined,
            senderId: requesterId,
            messageChannel: "webchat",
            messageProvider: "webchat",
            abortSignal: signal,
            permissionMode: live.entry.permissionMode,
            sessionRoot: live.entry.sessionRoot,
            toolOverrides: live.entry.toolOverrides,
            spawnedBy: live.entry.spawnedBy,
            groupId: live.entry.groupId,
            groupChannel: live.entry.groupChannel,
            groupSpace: live.entry.space,
            sessionTarget: {
              agentId,
              sessionId,
              sessionKey,
              storePath: live.storePath,
              expectedLifecycleRevision: live.entry.lifecycleRevision,
            },
          },
        });
        preparationOwner.setup = setup;
        assertPreparationCurrent();
        return setup.preparation;
      })();
      return preparing;
    };
    try {
      lease = await harness.acquireMcpAppRuntime({
        config: cfg,
        agentId,
        sessionId,
        sessionKey,
        workspaceDir,
        mcpServerNames: Object.keys(loaded.mcpServers),
        toolOverrides: target.entry.toolOverrides,
        assertCurrent: access.assertCurrent,
        appRequester: requesterId ? { kind: "gateway-profile", profileId: requesterId } : undefined,
        prepareSession,
      });
    } finally {
      try {
        preparationOwner.setup?.dispose();
      } finally {
        try {
          preparationOwner.source?.release();
        } finally {
          preparationOwner.access?.release();
        }
      }
    }
  } else {
    lease = await acquireSessionMcpRuntime({
      sessionId,
      sessionKey,
      workspaceDir,
      agentDir: resolveAgentDir(cfg, agentId),
      cfg,
      requesterSenderId: requesterId,
      messageChannel: "webchat",
      toolOverrides: target.entry.toolOverrides,
    });
  }
  if (!lease) {
    throw new Error("Open a conversation with this plugin before launching its App");
  }
  const acquired = lease;
  const runtime = acquired.runtime;
  const approvalReleases: Array<() => void> = [];
  try {
    current();
    const listed = await runtime.getCatalog();
    const catalog = {
      ...listed,
      servers: Object.fromEntries(
        Object.entries(listed.servers).map(([name, server]) => [
          name,
          { ...server, pluginId: server.pluginId ?? loaded.pluginIdsByServer?.[name] },
        ]),
      ),
    };
    current();
    const projected = buildBundleMcpToolsFromCatalog({ catalog, includeAppOnlyInventory: true });
    const names = new Map(
      projected.flatMap((tool) => {
        const mcp = getPluginToolMeta(tool)?.mcp;
        return mcp?.operation === "tool"
          ? [[JSON.stringify([mcp.serverName, mcp.toolName]), tool.name] as const]
          : [];
      }),
    );
    const assertTool = (
      tool: McpCatalogTool,
      interaction = false,
      assertAccess = access.assertCurrent,
    ) => {
      const live = current(assertAccess);
      if (options.context.getRuntimeConfig().mcp?.apps?.enabled !== true) {
        throw new Error("MCP Apps are disabled");
      }
      const rawServer = loaded.mcpServers[tool.serverName];
      if (
        (!rawServer &&
          !(runtime.assertOwnerCurrent && catalog.servers[tool.serverName]?.pluginId)) ||
        (rawServer &&
          !isMcpToolAllowed(normalizeMcpToolFilter(rawServer.toolFilter), tool.toolName))
      ) {
        throw new Error("MCP App tool is denied by server policy");
      }
      const name = names.get(JSON.stringify([tool.serverName, tool.toolName]));
      if (
        !name ||
        live.entry.toolOverrides?.mcpServers?.[tool.serverName] === false ||
        live.entry.toolOverrides?.mcpToolsDeny?.[tool.serverName]?.includes(tool.toolName)
      ) {
        throw new Error("MCP App tool is denied");
      }
      resolveSessionResourceToolPolicy({
        config: options.context.getRuntimeConfig(),
        client: options.client,
        current: live,
        readPreparedSessionEntry: (source) => projection.sharingTarget(source)?.entry,
        toolName: name,
        assertNativeRuntimeCurrent: runtime.assertOwnerCurrent,
      });
      return (
        interaction &&
        requiresMcpCodexToolApproval({
          mode:
            (rawServer
              ? resolveProjectedMcpCodexToolApprovalMode(tool.serverName, rawServer)
              : "prompt") ?? catalog.servers[tool.serverName]?.codexApprovalMode,
          fullPermission: live.entry.permissionMode === "full",
          annotations: tool.codexAnnotations,
        })
      );
    };
    const approveTool = async (tool: McpCatalogTool, input: Record<string, unknown>) => {
      const required = assertTool(tool, true);
      if (required) {
        const retained = access.retain();
        approvalReleases.push(retained.release);
        await requestMcpAppToolApproval({
          options,
          agentId,
          sessionKey,
          serverName: tool.serverName,
          toolName: tool.toolName,
          input,
          signal: retained.signal,
          assertCurrent: () => {
            retained.assertCurrent();
            assertTool(tool, true);
          },
        });
      }
      const assertExecutionCurrent = () => {
        if (assertTool(tool, true) && !required) {
          throw new Error("MCP App approval policy changed before execution");
        }
      };
      assertExecutionCurrent();
      return assertExecutionCurrent;
    };
    const tools = catalog.tools.filter((tool) => {
      try {
        assertTool(tool);
        return true;
      } catch {
        return false;
      }
    });
    const retainViewAuthority = (viewTools: McpCatalogTool[]) => {
      const retained = access.retain();
      const prepareToolCall: McpAppPrepareToolCall = async (request) => {
        const tool = viewTools.find((candidate) => candidate.toolName === request.toolName);
        if (!tool) {
          throw new Error("MCP App tool is not granted to this view");
        }
        const assertCurrent = () => {
          request.assertCurrent();
          retained.assertCurrent();
          assertTool(tool, false, retained.assertCurrent);
        };
        assertCurrent();
        const approvalRequired = assertTool(tool, true, retained.assertCurrent);
        if (approvalRequired) {
          await requestMcpAppToolApproval({
            options: request.options,
            agentId,
            sessionKey,
            serverName: tool.serverName,
            toolName: tool.toolName,
            input: request.input,
            view: request.view,
            requesterId: resolveMcpAppRequesterId(request.options.client),
            assertCurrent,
            signal: request.signal
              ? AbortSignal.any([retained.signal, request.signal])
              : retained.signal,
          });
        }
        const assertExecutionCurrent = () => {
          assertCurrent();
          if (assertTool(tool, true, retained.assertCurrent) && !approvalRequired) {
            throw new Error("MCP App approval policy changed before execution");
          }
        };
        assertExecutionCurrent();
        return assertExecutionCurrent;
      };
      return {
        ...retained,
        prepareToolCall,
        assertCurrent: () => {
          retained.assertCurrent();
          if (
            current(retained.assertCurrent).entry.permissionMode !== target.entry.permissionMode
          ) {
            throw new Error("MCP App permission mode changed; reopen the App");
          }
          for (const tool of viewTools) {
            assertTool(tool, false, retained.assertCurrent);
          }
        },
      };
    };
    return {
      approveTool,
      retainViewAuthority,
      options,
      runtime,
      catalog: { ...catalog, tools },
      agentId,
      sessionKey,
      sessionId,
      workspaceDir,
      requesterId,
      access,
      assertTool,
      assertCurrent: () => {
        current();
      },
      dispose: async () => {
        for (const release of approvalReleases.splice(0)) {
          release();
        }
        await releaseSessionMcpRuntime(acquired);
        await runtime.joinCleanup?.();
      },
    };
  } catch (error) {
    for (const release of approvalReleases.splice(0)) {
      release();
    }
    await releaseSessionMcpRuntime(lease);
    throw error;
  }
}
