import { buildNvidiaProvider } from "./src/agents/models-config.providers.js";

async function run() {
  console.log("Starting...");
  const provider = await buildNvidiaProvider("NVIDIA_API_KEY");
  console.log("Models length:", provider.models?.length);
  if (provider.models && provider.models.length > 0) {
    console.log(
      "First 5 models:",
      provider.models.slice(0, 5).map((m) => m.id),
    );
  }
}

run().catch(console.error);
