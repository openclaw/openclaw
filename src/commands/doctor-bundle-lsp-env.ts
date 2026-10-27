/** Doctor note for Gateway env vars that bundle LSP servers no longer inherit. */
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveStdioMcpServerLaunchConfig } from "../agents/mcp-stdio.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayService, type GatewayService } from "../daemon/service.js";
import { loadEnabledBundleLspConfig } from "../plugins/bundle-lsp.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import { shouldManageGatewayService } from "./doctor-service-repair-policy.js";

/** Notes commonly needed, non-secret Gateway env names that configured bundle LSP servers lack. */
export async function noteBundleLspEnvPassthrough(params: {
  cfg: OpenClawConfig;
  workspaceDirs: readonly string[];
  env?: NodeJS.ProcessEnv;
  service?: Pick<GatewayService, "readCommand">;
  runWithPluginMetadataSnapshot?: PluginMetadataSnapshotScopeRunner;
  noteFn?: typeof note;
}): Promise<void> {
  if (params.cfg.gateway?.mode === "remote") {
    return;
  }
  const { cfg, workspaceDirs } = params;
  const runWithPluginMetadataSnapshot = params.runWithPluginMetadataSnapshot;
  // Each workspace resolves its own servers at runtime, so one name can carry
  // different launch envs; keep every one so none hides another's withheld names.
  const servers = new Map<string, Array<Record<string, string> | undefined>>();
  for (const workspaceDir of workspaceDirs) {
    const load = () => loadEnabledBundleLspConfig({ workspaceDir, cfg });
    const loaded = runWithPluginMetadataSnapshot
      ? runWithPluginMetadataSnapshot({ config: cfg, workspaceDir }, load)
      : load();
    for (const [name, raw] of Object.entries(loaded.config.lspServers)) {
      const launch = resolveStdioMcpServerLaunchConfig(raw);
      if (launch.ok) {
        servers.set(name, [...(servers.get(name) ?? []), launch.config.env]);
      }
    }
  }
  if (servers.size === 0) {
    return;
  }
  const {
    collectWithheldLspEnvNames,
    formatWithheldLspEnvHints,
    LSP_ENV_PASSTHROUGH_DOCS_URL,
    resolveLspServerEnv,
  } = await import("../agents/agent-bundle-lsp-env.js");
  const env = params.env ?? process.env;
  const service = params.service ?? resolveGatewayService();
  const sources = [env];
  // A non-default profile cannot tell which installed service is its Gateway.
  if (isDefaultInstallIdentity(env) && (await shouldManageGatewayService(env))) {
    const command = await service.readCommand(env).catch(() => null);
    if (command?.environment) {
      sources.push(command.environment);
    }
  }
  const lines: string[] = [];
  for (const [name, serverEnvs] of [...servers].toSorted(([a], [b]) => a.localeCompare(b))) {
    const withheldEntries = serverEnvs.flatMap((serverEnv) =>
      sources.map((parentEnv) =>
        collectWithheldLspEnvNames({
          parentEnv,
          childEnv: resolveLspServerEnv(serverEnv, parentEnv),
        }),
      ),
    );
    const configurable = new Set(withheldEntries.flatMap((entry) => entry.configurable));
    const refused = new Set(withheldEntries.flatMap((entry) => entry.refused));
    for (const hint of formatWithheldLspEnvHints({
      configurable: [...configurable].toSorted(),
      refused: [...refused].toSorted(),
    })) {
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
