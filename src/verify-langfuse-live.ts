import * as dotenv from "dotenv";
import { Langfuse } from "langfuse";

// Load local environmental variables (.env)
dotenv.config();

async function runLivePromptCheck() {
  const promptName = "workspace/agents/lexguard-compliance-service/AGENTS";
  const targetLabel = "production";

  console.log(
    `📡 Connecting to Langfuse Host: ${process.env.LANGFUSE_HOST || "https://langfuse.guardianhub.com"}...`,
  );

  // 1. Initialize the live production client
  const langfuse = new Langfuse({
    publicKey: "pk-lf-2207abb4-5368-4c23-adcc-6284d0a65b97",
    secretKey: "sk-lf-373b0141-01b3-4d85-893e-de824473889a",
    baseUrl: "http://langfuse.guardianhub.com",
  });

  try {
    console.log(`📥 Fetching asset: "${promptName}" [Label: ${targetLabel}]...`);

    // 2. Pull the live prompt target from the registry
    const remotePrompt = await langfuse.getPrompt(promptName, undefined, {
      label: targetLabel,
    });

    if (!remotePrompt) {
      throw new Error("Registry returned an empty or invalid payload container.");
    }

    // 3. Test compilation mechanics with runtime variable context variables
    const sampleContext = {
      clusterNode: "guardianhub-edge-live-01",
      timestamp: new Date().toISOString(),
      sessionId: "live-preflight-check-token",
    };

    const compiledOutput = remotePrompt.compile(sampleContext);

    // ── VISUAL EXTRACTION MATRIX PANEL ──────────────────────────────────
    console.log(`\n┌── ✅ [LIVE REGISTRY VALIDATION SUCCESSFUL] ───────────────┐`);
    console.log(`│ Name:    ${promptName.padEnd(48)} │`);
    console.log(`│ Version: ${String(remotePrompt.version).padEnd(48)} │`);
    console.log(`├── Compiled Output Preview ──────────────────────────────────────┤`);

    // Print lines with a clean terminal border wrapper
    const outputLines = compiledOutput.split("\n");
    for (const line of outputLines.slice(0, 6)) {
      console.log(`│ ${line.substring(0, 64).padEnd(64)} │`);
    }
    if (outputLines.length > 6) {
      console.log(`│ ... [truncated long-form text content]                           │`);
    }
    console.log(`└─────────────────────────────────────────────────────────────────┘\n`);
  } catch (error: any) {
    console.error(`\n❌ [LIVE REGISTRY VALIDATION FAILED]`);
    console.error(`Reason: ${error?.message || error}\n`);
    process.exit(1);
  } finally {
    // Ensure all background analytics event loops exit gracefully
    await langfuse.shutdownAsync();
  }
}

runLivePromptCheck();
