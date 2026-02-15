import fsSync from "node:fs";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { note } from "../terminal/note.js";
import { resolveUserPath } from "../utils.js";

/**
 * Check MongoDB backend health when backend=mongodb.
 * Validates URI presence and attempts a connection test with timeout.
 */
export async function noteMongoDBBackendHealth(cfg: OpenClawConfig): Promise<void> {
  const agentId = resolveDefaultAgentId(cfg);
  let backendConfig;
  try {
    backendConfig = resolveMemoryBackendConfig({ cfg, agentId });
  } catch {
    // resolveMemoryBackendConfig throws when mongodb URI is missing
    if (cfg.memory?.backend === "mongodb") {
      note(
        [
          "MongoDB memory backend is configured but no URI is set.",
          "",
          "Fix (pick one):",
          `- Set URI in config: ${formatCliCommand("openclaw config set memory.mongodb.uri mongodb+srv://...")}`,
          "- Set OPENCLAW_MONGODB_URI environment variable",
          `- Switch backend: ${formatCliCommand("openclaw config set memory.backend builtin")}`,
        ].join("\n"),
        "Memory (MongoDB)",
      );
    }
    return;
  }

  if (backendConfig.backend !== "mongodb" || !backendConfig.mongodb) {
    return;
  }

  const { uri, deploymentProfile } = backendConfig.mongodb;

  // Connection test with timeout
  let MongoClient: typeof import("mongodb").MongoClient;
  try {
    ({ MongoClient } = await import("mongodb"));
  } catch {
    note(
      [
        "MongoDB driver is not installed.",
        "",
        "Fix (pick one):",
        "- Install: pnpm add mongodb",
        `- Switch backend: ${formatCliCommand("openclaw config set memory.backend builtin")}`,
      ].join("\n"),
      "Memory (MongoDB)",
    );
    return;
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  try {
    await client.connect();
    await client.db().command({ ping: 1 });

    note(`MongoDB connected. Profile: ${deploymentProfile}.`, "Memory (MongoDB)");

    // Check embedding coverage (embeddingStatus) while connection is still open
    await noteEmbeddingCoverage(client, backendConfig.mongodb);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note(
      [
        `MongoDB connection failed: ${message}`,
        "",
        "Fix (pick one):",
        "- Check that MongoDB is running and accessible",
        "- Verify URI credentials and network access",
        `- Test manually: mongosh "${redactDoctorUri(uri)}"`,
        `- Switch backend: ${formatCliCommand("openclaw config set memory.backend builtin")}`,
      ].join("\n"),
      "Memory (MongoDB)",
    );
    return;
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Check embedding coverage across all chunk collections.
 * Warns the user if any chunks have embeddingStatus: "failed".
 */
async function noteEmbeddingCoverage(
  client: import("mongodb").MongoClient,
  mongoCfg: { database: string; collectionPrefix: string },
): Promise<void> {
  try {
    const { getMemoryStats } = await import("../memory/mongodb-analytics.js");
    const db = client.db(mongoCfg.database);
    const stats = await getMemoryStats(db, mongoCfg.collectionPrefix);

    const { embeddingStatusCoverage } = stats;
    if (embeddingStatusCoverage.failed > 0) {
      note(
        [
          `Embedding coverage: ${embeddingStatusCoverage.failed} chunks have failed embeddings.`,
          `  Success: ${embeddingStatusCoverage.success}`,
          `  Failed: ${embeddingStatusCoverage.failed}`,
          `  Pending: ${embeddingStatusCoverage.pending}`,
          `  Total: ${embeddingStatusCoverage.total}`,
          "",
          "Failed chunks will be re-embedded on the next sync cycle.",
          "If failures persist, check your embedding provider configuration.",
        ].join("\n"),
        "Memory (Embedding Coverage)",
      );
    } else if (embeddingStatusCoverage.total > 0) {
      const successRate =
        embeddingStatusCoverage.total > 0
          ? Math.round((embeddingStatusCoverage.success / embeddingStatusCoverage.total) * 100)
          : 0;
      note(
        `Embedding coverage: ${successRate}% (${embeddingStatusCoverage.success}/${embeddingStatusCoverage.total} chunks).`,
        "Memory (Embedding Coverage)",
      );
    }
  } catch {
    // Silently skip — stats aggregation may fail on empty or new databases
  }
}

function redactDoctorUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.password) {
      parsed.password = "***";
    }
    if (parsed.username && parsed.username.length > 4) {
      parsed.username = parsed.username.slice(0, 4) + "...";
    }
    return parsed.toString();
  } catch {
    return uri.replace(/:([^@]+)@/, ":***@");
  }
}

/**
 * Check whether memory search has a usable embedding provider.
 * Runs as part of `openclaw doctor` — config-only, no network calls.
 */
export async function noteMemorySearchHealth(cfg: OpenClawConfig): Promise<void> {
  // Check MongoDB backend health first
  await noteMongoDBBackendHealth(cfg);

  const agentId = resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  const resolved = resolveMemorySearchConfig(cfg, agentId);
  const hasRemoteApiKey = Boolean(resolved?.remote?.apiKey?.trim());

  if (!resolved) {
    note("Memory search is explicitly disabled (enabled: false).", "Memory search");
    return;
  }

  // If a specific provider is configured (not "auto"), check only that one.
  if (resolved.provider !== "auto") {
    if (resolved.provider === "local") {
      if (hasLocalEmbeddings(resolved.local)) {
        return; // local model file exists
      }
      note(
        [
          'Memory search provider is set to "local" but no local model file was found.',
          "",
          "Fix (pick one):",
          `- Install node-llama-cpp and set a local model path in config`,
          `- Switch to a remote provider: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.provider openai")}`,
          "",
          `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
        ].join("\n"),
        "Memory search",
      );
      return;
    }
    // Remote provider — check for API key
    if (hasRemoteApiKey || (await hasApiKeyForProvider(resolved.provider, cfg, agentDir))) {
      return;
    }
    const envVar = providerEnvVar(resolved.provider);
    note(
      [
        `Memory search provider is set to "${resolved.provider}" but no API key was found.`,
        `Semantic recall will not work without a valid API key.`,
        "",
        "Fix (pick one):",
        `- Set ${envVar} in your environment`,
        `- Add credentials: ${formatCliCommand(`openclaw auth add --provider ${resolved.provider}`)}`,
        `- To disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
        "",
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].join("\n"),
      "Memory search",
    );
    return;
  }

  // provider === "auto": check all providers in resolution order
  if (hasLocalEmbeddings(resolved.local)) {
    return;
  }
  for (const provider of ["openai", "gemini", "voyage"] as const) {
    if (hasRemoteApiKey || (await hasApiKeyForProvider(provider, cfg, agentDir))) {
      return;
    }
  }

  note(
    [
      "Memory search is enabled but no embedding provider is configured.",
      "Semantic recall will not work without an embedding provider.",
      "",
      "Fix (pick one):",
      "- Set OPENAI_API_KEY or GEMINI_API_KEY in your environment",
      `- Add credentials: ${formatCliCommand("openclaw auth add --provider openai")}`,
      `- For local embeddings: configure agents.defaults.memorySearch.provider and local model path`,
      `- To disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
      "",
      `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
    ].join("\n"),
    "Memory search",
  );
}

function hasLocalEmbeddings(local: { modelPath?: string }): boolean {
  const modelPath = local.modelPath?.trim();
  if (!modelPath) {
    return false;
  }
  // Remote/downloadable models (hf: or http:) aren't pre-resolved on disk,
  // so we can't confirm availability without a network call. Treat as
  // potentially available — the user configured it intentionally.
  if (/^(hf:|https?:)/i.test(modelPath)) {
    return true;
  }
  const resolved = resolveUserPath(modelPath);
  try {
    return fsSync.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

async function hasApiKeyForProvider(
  provider: "openai" | "gemini" | "voyage",
  cfg: OpenClawConfig,
  agentDir: string,
): Promise<boolean> {
  // Map embedding provider names to model-auth provider names
  const authProvider = provider === "gemini" ? "google" : provider;
  try {
    await resolveApiKeyForProvider({ provider: authProvider, cfg, agentDir });
    return true;
  } catch {
    return false;
  }
}

function providerEnvVar(provider: string): string {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "gemini":
      return "GEMINI_API_KEY";
    case "voyage":
      return "VOYAGE_API_KEY";
    default:
      return `${provider.toUpperCase()}_API_KEY`;
  }
}
