import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";

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
