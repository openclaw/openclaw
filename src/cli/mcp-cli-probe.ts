import { expectDefined } from "@openclaw/normalization-core";
import type { SessionMcpRuntime } from "../agents/agent-bundle-mcp-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createLazyRuntimeMethod } from "../shared/lazy-runtime.js";

const createSessionMcpRuntime = createLazyRuntimeMethod(
  () => import("../agents/agent-bundle-mcp-runtime.js"),
  (runtime) => runtime.createSessionMcpRuntime,
);

const MCP_CODEX_APPROVAL_ANNOTATION_HINT =
  "tools have no safety annotations; calls require approval in prompting session postures";

async function readMcpProbeResult(runtime: SessionMcpRuntime) {
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

export async function probeMcpServers(
  sessionId: string,
  config: OpenClawConfig,
  servers: Record<string, Record<string, unknown>>,
) {
  const { recoverMcpDockerServers } = await import("../agents/mcp-docker-recovery.js");
  await recoverMcpDockerServers(Object.values(servers));
  const runtime = await createSessionMcpRuntime({
    sessionId,
    workspaceDir: process.cwd(),
    cfg: { ...config, mcp: { ...config.mcp, servers } },
    manifestRegistry: { plugins: [] },
  });
  let result: Awaited<ReturnType<typeof readMcpProbeResult>>;
  let cleanupError: string | undefined;
  try {
    result = await readMcpProbeResult(runtime);
  } finally {
    try {
      await runtime.dispose();
      // Disposal is best effort; joining exposes any unconfirmed closure.
      await runtime.joinCleanup?.();
    } catch (err) {
      cleanupError = `${formatErrorMessage(err)}. Rerun this command; if local cleanup still fails, restart the process that owns the MCP connection.`;
    }
  }
  return { ...result, ...(cleanupError ? { cleanupError } : {}) };
}

export function resolveMcpProbeIssue(params: {
  result: Awaited<ReturnType<typeof probeMcpServers>>;
  servers: Record<string, Record<string, unknown>>;
  path: string;
}): string | undefined {
  let probeIssue: string | undefined;
  if (params.result.diagnostics.length > 0) {
    const first = expectDefined(params.result.diagnostics[0], "diagnostics entry at 0");
    probeIssue = `MCP check failed for "${first.serverName}" in ${params.path}: ${first.message}`;
  } else {
    for (const [name, server] of Object.entries(params.servers)) {
      if (server.enabled !== false && !params.result.servers[name]) {
        probeIssue = `MCP check did not connect to "${name}" in ${params.path}.`;
        break;
      }
    }
  }
  const cleanupIssue = params.result.cleanupError
    ? `MCP cleanup failed in ${params.path}: ${params.result.cleanupError}`
    : undefined;
  return [probeIssue, cleanupIssue].filter(Boolean).join("\n") || undefined;
}
