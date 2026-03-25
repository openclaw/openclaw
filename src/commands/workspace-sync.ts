import { pullAndApplyWorkspaceSync, pushWorkspaceToRemote } from "../agents/workspace-sync.js";
import { loadConfig } from "../config/config.js";
import { theme } from "../terminal/theme.js";

/**
 * CLI command handler for pulling workspace context files from a remote manifest.
 */
export async function workspaceSyncPullCommand(opts: { json?: boolean; workspace?: string }) {
  const config = loadConfig();
  const syncCfg = config.agents?.defaults?.workspaceSync;

  if (!syncCfg?.enabled) {
    const errorMsg = "Workspace sync is not enabled in configuration.";
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: errorMsg }));
    } else {
      console.error(theme.error(errorMsg));
      console.error(
        theme.muted(
          "Enable it via: openclaw config set agents.defaults.workspaceSync.enabled true",
        ),
      );
    }
    process.exit(1);
  }

  // Use CLI-provided workspace, then configured workspace, then default
  const workspace = opts.workspace ?? config.agents?.defaults?.workspace;
  const result = await pullAndApplyWorkspaceSync(syncCfg, workspace);

  if (opts.json) {
    console.log(JSON.stringify(result));
  } else {
    if (result.ok) {
      console.log(theme.success("Workspace sync pull successfully completed."));
      if (result.filesUpdated.length > 0) {
        console.log(theme.muted(`Files updated: ${result.filesUpdated.join(", ")}`));
      } else {
        console.log(theme.info("No remote changes detected (files are already up-to-date)."));
      }
    } else {
      console.error(theme.error(`Workspace sync pull failed: ${result.error}`));
      process.exit(1);
    }
  }
}

/**
 * CLI command handler for pushing local workspace context files to a remote endpoint.
 */
export async function workspaceSyncPushCommand(opts: { json?: boolean; workspace?: string }) {
  const config = loadConfig();
  const syncCfg = config.agents?.defaults?.workspaceSync;

  if (!syncCfg?.enabled) {
    const errorMsg = "Workspace sync is not enabled in configuration.";
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: errorMsg }));
    } else {
      console.error(theme.error(errorMsg));
    }
    process.exit(1);
  }

  // Use CLI-provided workspace, then configured workspace, then default
  const workspace = opts.workspace ?? config.agents?.defaults?.workspace;
  const result = await pushWorkspaceToRemote(syncCfg, workspace);

  if (opts.json) {
    console.log(JSON.stringify(result));
  } else {
    if (result.ok) {
      console.log(theme.success("Workspace sync push successfully completed."));
      if (result.filesUpdated.length > 0) {
        console.log(theme.muted(`Files pushed: ${result.filesUpdated.join(", ")}`));
      } else {
        console.log(theme.info("No supported workspace files found locally to push."));
      }
    } else {
      console.error(theme.error(`Workspace sync push failed: ${result.error}`));
      process.exit(1);
    }
  }
}
