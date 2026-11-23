// `openclaw update plugins`: plugin maintenance for the release this process runs from. The
// updater runs it from the new release before the restart, so plugins are chosen by the new core.
import { preparePostCorePluginConfig } from "../cli/update-cli/update-command-config.js";
import { updatePluginsAfterCoreUpdate } from "../cli/update-cli/update-command-plugins.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import type { UpdateChannel } from "../infra/update-channels.js";
import { loadInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { createNonExitingRuntime } from "../runtime.js";

export async function maintainPlugins(opts: {
  channel: UpdateChannel;
  timeoutMs: number;
  acceptCapabilities: boolean;
}) {
  const root = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (!root) {
    throw new Error("This release's package root was not found.");
  }
  return await withCommandProcessScope(async () =>
    updatePluginsAfterCoreUpdate({
      root,
      channel: opts.channel,
      ...(await preparePostCorePluginConfig({ requestedChannel: null })),
      json: true,
      acceptCapabilities: opts.acceptCapabilities,
      timeoutMs: opts.timeoutMs,
      pluginInstallRecords: await loadInstalledPluginIndexInstallRecords(),
      runtime: createNonExitingRuntime(),
    }),
  );
}
