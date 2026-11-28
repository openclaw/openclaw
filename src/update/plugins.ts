// `openclaw update plugins`: maintenance with this release's code. Prepared updates
// run it after the candidate is serving, before reloading the changed plugins.
import { preparePostCorePluginConfig } from "../cli/update-cli/update-command-config.js";
import type { PostCorePluginUpdateResult } from "../cli/update-cli/update-command-plugins-internals.js";
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
}): Promise<PostCorePluginUpdateResult> {
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
