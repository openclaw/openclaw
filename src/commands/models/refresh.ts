import { ExpectedCliError } from "../../cli/failure-output.js";
import { runWithLocalStateOwner } from "../../cli/local-state-owner.js";
import { refreshRemoteModelCatalog } from "../../model-catalog/remote-refresh.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

export async function modelsRefreshCommand(
  options: { json?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const result = await runWithLocalStateOwner({
    method: "models.refresh",
    params: {},
    target: "remote model catalog",
    onForeignOwner: "refuse",
    runLocal: async ({ config, env, signal, assertCurrent }) => {
      assertCurrent();
      return await refreshRemoteModelCatalog({
        config,
        force: true,
        signal,
        databaseOptions: { env },
      });
    },
  });
  if (result.status === "error") {
    const message = `Remote catalog refresh failed: ${result.error}`;
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }
  if (options.json) {
    writeRuntimeJson(runtime, result, 0);
    return;
  }
  if (result.status === "disabled") {
    runtime.log("Remote catalog refresh is disabled (models.catalogRefresh.enabled=false)");
    return;
  }
  runtime.log(
    `Remote catalog refresh: ${result.status} (${result.providers} providers, ${result.models} models; generated ${new Date(result.generatedAt).toISOString()})`,
  );
}
