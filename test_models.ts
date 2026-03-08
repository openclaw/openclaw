import { ensureOpenClawModelsJson, loadModelProviders } from "./src/agents/models-config.js";
import { buildModelsProviderData } from "./src/auto-reply/reply/commands-models.js";
import { loadConfig } from "./src/config/config.js";

async function main() {
  const cfg = loadConfig();
  await ensureOpenClawModelsJson();
  const providersKeys = Object.keys(await loadModelProviders(cfg.agents?.authStore));
  console.log("Providers initialized:", providersKeys);

  const data = await buildModelsProviderData(cfg);
  console.log("Providers found:", data.providers);

  const nvidiaModels = data.byProvider.get("nvidia");
  if (nvidiaModels) {
    console.log("NVIDIA Models count:", nvidiaModels.size);
    console.log("NVIDIA Models:", Array.from(nvidiaModels));
  } else {
    console.log("No NVIDIA models found.");
  }
}

main().catch(console.error);
