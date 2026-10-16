import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createLazyRuntimeMethod } from "../shared/lazy-runtime.js";

const createSessionMcpRuntime = createLazyRuntimeMethod(
  () => import("../agents/agent-bundle-mcp-runtime.js"),
  (runtime) => runtime.createSessionMcpRuntime,
);

type LoadedMcpConfig = Extract<Awaited<ReturnType<typeof listConfiguredMcpServers>>, { ok: true }>;

/**
 * Plugin inventory shared by the CLI's effective view and by probe/doctor
 * runtimes. Probes must pass this registry instead of copying plugin servers
 * into `mcp.servers`, or the runtime relabels them as operator-configured and
 * drops the plugin's `PLUGIN_DATA` launch-directory ownership.
 */
export type McpPluginInventory = Pick<PluginManifestRegistry, "plugins">;

/**
 * Effective MCP servers as agent runtimes see them: MCP servers declared by
 * enabled plugins overlaid by operator `mcp.servers` config. Read and OAuth
 * commands must use this view so plugin-declared servers (for example the
 * official GitLab plugin's `gitlab` server) stay reachable; write commands keep
 * operating on the config-only registry they own.
 *
 * Unlike the runtime merge, disabled config entries stay visible here so
 * `list`, `status`, and `doctor` can still report them.
 */
export async function loadEffectiveMcpConfig(loaded: LoadedMcpConfig) {
  const [
    { loadEnabledBundleMcpConfig },
    { loadPluginManifestRegistryForPluginRegistry },
    { resolvePluginControlPlaneWorkspace },
  ] = await Promise.all([
    import("../plugins/bundle-mcp.js"),
    import("../plugins/plugin-registry.js"),
    import("../plugins/control-plane-workspace.js"),
  ]);
  // The control plane deliberately resolves no workspace when it cannot prove a
  // single system owner; keep that omitted scope instead of inventing a cwd.
  const { workspaceDir } = resolvePluginControlPlaneWorkspace({ config: loaded.config });
  const pluginInventory: McpPluginInventory = {
    plugins: loadPluginManifestRegistryForPluginRegistry({
      workspaceDir,
      config: loaded.config,
      includeDisabled: true,
    }).plugins,
  };
  const bundle = loadEnabledBundleMcpConfig({
    workspaceDir,
    cfg: loaded.config,
    manifestRegistry: pluginInventory,
  });
  const configuredMcpServers = loaded.mcpServers;
  // Plugin-declared defaults first; operator config overrides by server name.
  return {
    ...loaded,
    configuredMcpServers,
    pluginInventory,
    mcpServers: { ...bundle.config.mcpServers, ...configuredMcpServers },
  };
}

const MCP_CODEX_APPROVAL_ANNOTATION_HINT =
  "tools have no safety annotations; calls require approval in prompting session postures";

export async function readMcpProbeResult(runtime: SessionMcpRuntime) {
  const { buildBundleMcpToolsFromCatalog } =
    await import("../agents/agent-bundle-mcp-materialize.js");
  const catalog = await runtime.getCatalog();
  const projectedTools = buildBundleMcpToolsFromCatalog({ catalog });
  return {
    generatedAt: new Date(catalog.generatedAt).toISOString(),
    servers: Object.fromEntries(
      Object.entries(catalog.servers)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, server]) => {
          const codexApprovalMode = server.codexApprovalMode ?? "auto";
          const serverTools = catalog.tools.filter((tool) => tool.serverName === name);
          const approvalHint =
            codexApprovalMode === "auto" &&
            serverTools.length > 0 &&
            serverTools.every((tool) => Object.keys(tool.codexAnnotations ?? {}).length === 0)
              ? MCP_CODEX_APPROVAL_ANNOTATION_HINT
              : undefined;
          return [
            name,
            {
              launch: server.launchSummary,
              tools: server.toolCount,
              codexApprovalMode,
              ...(approvalHint ? { approvalHint } : {}),
              ...(server.requestTimeoutMs ? { requestTimeoutMs: server.requestTimeoutMs } : {}),
              ...(server.supportsParallelToolCalls
                ? { supportsParallelToolCalls: server.supportsParallelToolCalls }
                : {}),
              ...(server.tools?.filteredCount ? { filteredTools: server.tools.filteredCount } : {}),
              ...(server.resources ? { resources: true } : {}),
              ...(server.prompts ? { prompts: true } : {}),
              ...(server.tools?.listChanged ||
              server.resources?.listChanged ||
              server.prompts?.listChanged
                ? {
                    listChanged: {
                      tools: server.tools?.listChanged === true,
                      resources: server.resources?.listChanged === true,
                      prompts: server.prompts?.listChanged === true,
                    },
                  }
                : {}),
            },
          ];
        }),
    ),
    tools: projectedTools.map((tool) => tool.name).toSorted(),
    diagnostics: catalog.diagnostics ?? [],
  };
}

/**
 * Builds a probe/doctor runtime. `servers` may only carry operator-configured
 * definitions; plugin-declared servers arrive through `pluginInventory` so their
 * launch ownership (for example `PLUGIN_DATA` directories) is preserved.
 * `includeServerNames` keeps the runtime scoped to the requested server(s).
 */
export function createMcpProbeRuntime(
  sessionId: string,
  config: OpenClawConfig,
  servers: Record<string, Record<string, unknown>>,
  scope?: {
    pluginInventory?: McpPluginInventory | undefined;
    includeServerNames?: ReadonlySet<string> | undefined;
  },
): Promise<SessionMcpRuntime> {
  return createSessionMcpRuntime({
    sessionId,
    // Session working directory only; plugin discovery comes from `manifestRegistry`.
    workspaceDir: process.cwd(),
    cfg: { ...config, mcp: { ...config.mcp, servers } },
    manifestRegistry: scope?.pluginInventory ?? { plugins: [] },
    ...(scope?.includeServerNames ? { includeServerNames: scope.includeServerNames } : {}),
  });
}

/**
 * Plugin-declared servers must not be injected into `mcp.servers`: that would
 * relabel them as operator-configured and drop their launch ownership.
 */
export function selectConfiguredProbeServers(
  servers: Record<string, Record<string, unknown>>,
  configuredServers: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(servers).filter(([serverName]) => Object.hasOwn(configuredServers, serverName)),
  );
}
