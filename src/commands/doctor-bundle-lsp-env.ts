/** Doctor note for Gateway env vars that bundle LSP servers no longer inherit. */
import { note } from "../../packages/terminal-core/src/note.js";
import {
  collectWithheldLspEnvNames,
  formatWithheldLspEnvHints,
  LSP_ENV_PASSTHROUGH_DOCS_URL,
  resolveLspServerEnv,
  type WithheldLspEnvNames,
} from "../agents/agent-bundle-lsp-env.js";
import { resolveStdioMcpServerLaunchConfig } from "../agents/mcp-stdio.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayService, type GatewayService } from "../daemon/service.js";
import { loadEnabledBundleLspConfig } from "../plugins/bundle-lsp.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import { shouldManageGatewayService } from "./doctor-service-repair-policy.js";

type LoadBundleLspConfig = typeof loadEnabledBundleLspConfig;

function collectRunnableLspServers(params: {
  cfg: OpenClawConfig;
  workspaceDirs: readonly string[];
  loadLspConfig: LoadBundleLspConfig;
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
}): Map<string, Array<Record<string, string> | undefined>> {
  // Each workspace resolves its own servers at runtime, so one name can carry
  // different launch envs; keep every one so none hides another's withheld names.
  const servers = new Map<string, Array<Record<string, string> | undefined>>();
  for (const workspaceDir of params.workspaceDirs) {
    const load = () => params.loadLspConfig({ workspaceDir, cfg: params.cfg });
    const loaded = params.runWithPluginMetadataSnapshot
      ? params.runWithPluginMetadataSnapshot({ config: params.cfg, workspaceDir }, load)
      : load();
    for (const [name, raw] of Object.entries(loaded.config.lspServers)) {
      const launch = resolveStdioMcpServerLaunchConfig(raw);
      if (launch.ok) {
        servers.set(name, [...(servers.get(name) ?? []), launch.config.env]);
      }
    }
  }
  return servers;
}

async function resolveGatewayEnvSources(params: {
  env: NodeJS.ProcessEnv;
  service: Pick<GatewayService, "readCommand">;
}): Promise<NodeJS.ProcessEnv[]> {
  const sources = [params.env];
  // A non-default profile cannot tell which installed service is its Gateway.
  if (!isDefaultInstallIdentity(params.env) || !(await shouldManageGatewayService(params.env))) {
    return sources;
  }
  const command = await params.service.readCommand(params.env).catch(() => null);
  if (command?.environment) {
    sources.push(command.environment);
  }
  return sources;
}

function mergeWithheld(entries: WithheldLspEnvNames[]): WithheldLspEnvNames {
  const configurable = new Set(entries.flatMap((entry) => entry.configurable));
  const refused = new Set(entries.flatMap((entry) => entry.refused));
  return { configurable: [...configurable].toSorted(), refused: [...refused].toSorted() };
}

/** Notes commonly needed, non-secret Gateway env names that configured bundle LSP servers lack. */
export async function noteBundleLspEnvPassthrough(params: {
  cfg: OpenClawConfig;
  workspaceDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
  service?: Pick<GatewayService, "readCommand">;
  loadLspConfig?: LoadBundleLspConfig;
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
  noteFn?: typeof note;
}): Promise<void> {
  if (params.cfg.gateway?.mode === "remote") {
    return;
  }
  const servers = collectRunnableLspServers({
    cfg: params.cfg,
    workspaceDirs: params.workspaceDirs,
    loadLspConfig: params.loadLspConfig ?? loadEnabledBundleLspConfig,
    runWithPluginMetadataSnapshot: params.runWithPluginMetadataSnapshot,
  });
  if (servers.size === 0) {
    return;
  }
  const sources = await resolveGatewayEnvSources({
    env: params.env ?? process.env,
    service: params.service ?? resolveGatewayService(),
  });
  const lines: string[] = [];
  for (const [name, serverEnvs] of [...servers].toSorted(([a], [b]) => a.localeCompare(b))) {
    const withheld = mergeWithheld(
      serverEnvs.flatMap((serverEnv) =>
        sources.map((parentEnv) =>
          collectWithheldLspEnvNames({
            parentEnv,
            childEnv: resolveLspServerEnv(serverEnv, parentEnv),
          }),
        ),
      ),
    );
    for (const hint of formatWithheldLspEnvHints(withheld)) {
      lines.push(`- "${name}": ${hint}`);
    }
  }
  if (lines.length === 0) {
    return;
  }
  (params.noteFn ?? note)(
    [
      "Bundle LSP servers start from an allowlisted environment, not the full Gateway environment. These Gateway variables are set but not passed:",
      ...lines,
      `Docs: ${LSP_ENV_PASSTHROUGH_DOCS_URL}`,
    ].join("\n"),
    "Bundle LSP environment",
  );
}
