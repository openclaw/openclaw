import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryMongoDBDeploymentProfile } from "../config/types.memory.js";
import type { WizardPrompter } from "./prompts.js";
import { DEFAULT_AGENTS_FILENAME, DEFAULT_MEMORY_FILENAME } from "../agents/workspace.js";
import { resolveOpenClawPackageName } from "../infra/openclaw-root.js";

/**
 * Interactive memory backend selection for the onboarding wizard.
 * Only shown in advanced mode. Returns updated config with memory backend settings.
 *
 * When running as @romiluz/clawmongo, MongoDB is the recommended default.
 * When running as openclaw (upstream), builtin (SQLite) remains the default.
 */
export async function setupMemoryBackend(
  config: OpenClawConfig,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const packageName = await resolveOpenClawPackageName();
  const isClawMongo = packageName === "@romiluz/clawmongo";
  const defaultBackend = config.memory?.backend ?? (isClawMongo ? "mongodb" : "builtin");

  const backend = await prompter.select({
    message: "Memory backend",
    options: [
      {
        value: "builtin" as const,
        label: "Built-in (SQLite)",
        hint: isClawMongo
          ? "Basic. Local-only, no multi-instance support."
          : "Default. Works everywhere, no setup needed.",
      },
      {
        value: "mongodb" as const,
        label: isClawMongo ? "MongoDB (Recommended)" : "MongoDB",
        hint: isClawMongo
          ? "ACID transactions, vector search, TTL, analytics, change streams."
          : "Scalable. Requires MongoDB 8.0+ connection.",
      },
      {
        value: "qmd" as const,
        label: "QMD",
        hint: "Advanced. Local semantic search with qmd binary.",
      },
    ],
    initialValue: defaultBackend,
  });

  if (backend === "builtin") {
    return config;
  }

  if (backend === "mongodb") {
    return setupMongoDBMemory(config, prompter, isClawMongo);
  }

  // QMD — set backend, existing QMD config flow handles the rest
  return {
    ...config,
    memory: { ...config.memory, backend: "qmd" },
  };
}

async function setupMongoDBMemory(
  config: OpenClawConfig,
  prompter: WizardPrompter,
  isClawMongo: boolean,
): Promise<OpenClawConfig> {
  // --- Auto-Setup: try Docker auto-start BEFORE manual URI prompt ---
  // Only for ClawMongo; upstream openclaw skips directly to manual URI
  if (isClawMongo) {
    try {
      const { attemptAutoSetup } = await import("./mongodb-auto-setup.js");
      const autoResult = await attemptAutoSetup(prompter);
      if (autoResult.success) {
        // Auto-setup succeeded - use the URI directly, skip manual prompt
        return continueMongoDBSetup(config, prompter, isClawMongo, autoResult.uri);
      }
      // Auto-setup failed but non-fatal - show reason and fall through to manual
      await prompter.note(autoResult.reason, "Auto-Setup");
    } catch {
      // Auto-setup module failed to load or threw - fall through to manual
    }
  }

  const existingUri = config.memory?.mongodb?.uri?.trim();
  const uri = await prompter.text({
    message: "MongoDB connection URI",
    placeholder: isClawMongo
      ? "mongodb://localhost:27017/openclaw"
      : "mongodb+srv://user:pass@cluster.mongodb.net/",
    initialValue: existingUri,
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return "URI is required for MongoDB backend";
      }
      if (!trimmed.startsWith("mongodb://") && !trimmed.startsWith("mongodb+srv://")) {
        return "URI must start with mongodb:// or mongodb+srv://";
      }
      return undefined;
    },
  });

  return continueMongoDBSetup(config, prompter, isClawMongo, uri.trim());
}

/**
 * Continue MongoDB setup after a URI has been obtained (either from auto-setup or manual prompt).
 * Performs topology detection, profile selection, embedding config, and KB import.
 */
async function continueMongoDBSetup(
  config: OpenClawConfig,
  prompter: WizardPrompter,
  isClawMongo: boolean,
  initialUri: string,
): Promise<OpenClawConfig> {
  let trimmedUri = initialUri;
  const isAtlas = trimmedUri.includes(".mongodb.net");

  // --- Topology Detection (after URI, before profile selection) ---
  let detectedTier: import("../memory/mongodb-topology.js").DeploymentTier | undefined;

  if (!isAtlas) {
    try {
      const { MongoClient } = await import("mongodb");
      const testClient = new MongoClient(trimmedUri, {
        serverSelectionTimeoutMS: 5_000,
        connectTimeoutMS: 5_000,
      });
      try {
        await testClient.connect();
        const { detectTopology, topologyToTier, tierFeatures, suggestConnectionString } =
          await import("../memory/mongodb-topology.js");
        const testDb = testClient.db();
        const topology = await detectTopology(testDb);
        detectedTier = topologyToTier(topology);
        const features = tierFeatures(detectedTier);

        // Suggest connection string with replicaSet if detected
        const suggestedUri = suggestConnectionString(topology, trimmedUri);
        if (suggestedUri !== trimmedUri) {
          await prompter.note(
            `Detected replica set "${topology.replicaSetName}". Recommended URI:\n${suggestedUri}`,
            "Connection String",
          );
          trimmedUri = suggestedUri;
        }

        // Show detected features
        const lines: string[] = [
          `Detected: ${detectedTier} (MongoDB ${topology.serverVersion})`,
          "",
          "Available features:",
          ...features.available.map((f) => `  + ${f}`),
        ];
        if (features.unavailable.length > 0) {
          lines.push("", "Not available (upgrade to enable):");
          lines.push(...features.unavailable.map((f) => `  - ${f}`));
        }

        // Docker-compose hint for standalone/replicaset users
        if (detectedTier === "standalone") {
          lines.push(
            "",
            "Upgrade to full stack with docker-compose:",
            "  ./docker/mongodb/start.sh fullstack",
          );
        } else if (detectedTier === "replicaset") {
          lines.push("", "Add vector search with mongot:", "  ./docker/mongodb/start.sh fullstack");
        }

        await prompter.note(lines.join("\n"), "MongoDB Topology");
      } finally {
        await testClient.close().catch(() => {});
      }
    } catch {
      // Connection failed -- skip topology detection, user will manually select profile
    }
  }

  // Auto-suggest profile based on detected topology (or URI heuristic)
  const suggestedProfile: MemoryMongoDBDeploymentProfile = (() => {
    if (isAtlas) {
      return "atlas-default";
    }
    if (detectedTier) {
      if (detectedTier === "fullstack") {
        return "community-mongot";
      }
      return "community-bare";
    }
    return "community-mongot";
  })();

  const profile = await prompter.select<MemoryMongoDBDeploymentProfile>({
    message: "Deployment profile",
    options: [
      {
        value: "atlas-default",
        label: "Atlas (standard)",
        hint: "Full Atlas Search + Vector Search",
      },
      {
        value: "atlas-m0",
        label: "Atlas (free tier M0)",
        hint: "Limited to 3 search indexes total",
      },
      {
        value: "community-mongot",
        label: "Community + mongot",
        hint: "Self-hosted with mongot search engine",
      },
      {
        value: "community-bare",
        label: "Community (bare)",
        hint: "No mongot. Keyword search via $text only",
      },
    ],
    initialValue: suggestedProfile,
  });

  // Auto-set embeddingMode based on profile
  const isCommunity = profile === "community-mongot" || profile === "community-bare";
  const embeddingMode = isCommunity ? "managed" : "automated";

  const baseResult: OpenClawConfig = {
    ...config,
    memory: {
      ...config.memory,
      backend: "mongodb",
      mongodb: {
        ...config.memory?.mongodb,
        uri: trimmedUri,
        deploymentProfile: profile,
        embeddingMode,
      },
    },
  };

  if (!isCommunity) {
    return offerKBImport(baseResult, prompter, isClawMongo, trimmedUri);
  }

  // community-bare: no mongot → text search only, no vector search possible
  if (profile === "community-bare") {
    await prompter.note(
      [
        "Text/keyword search via $text is available out of the box.",
        "Vector/semantic search requires mongot (Community + mongot profile).",
      ].join("\n"),
      "Search Capabilities",
    );
    return offerKBImport(baseResult, prompter, isClawMongo, trimmedUri);
  }

  // community-mongot: vector search available with managed embeddings
  const wantVectorSearch = await prompter.confirm({
    message: "Enable vector/semantic search? (requires an embedding API key)",
    initialValue: true,
  });

  if (!wantVectorSearch) {
    await prompter.note(
      [
        "Text search will work out of the box.",
        `Enable later: ${isClawMongo ? "clawmongo" : "openclaw"} configure → Memory`,
      ].join("\n"),
      "Text Search Only",
    );
    return offerKBImport(baseResult, prompter, isClawMongo, trimmedUri);
  }

  const embeddingProvider = await prompter.select<"openai" | "gemini" | "voyage" | "local">({
    message: "Embedding provider for vector search",
    options: [
      { value: "voyage", label: "Voyage AI", hint: "Best for code retrieval" },
      { value: "openai", label: "OpenAI", hint: "text-embedding-3-small" },
      { value: "gemini", label: "Google Gemini", hint: "text-embedding-004" },
      { value: "local", label: "Local (no API key needed)", hint: "On-device via node-llama-cpp" },
    ],
    initialValue: "voyage",
  });

  if (embeddingProvider === "local") {
    const localResult: OpenClawConfig = {
      ...baseResult,
      agents: {
        ...baseResult.agents,
        defaults: {
          ...baseResult.agents?.defaults,
          memorySearch: {
            ...baseResult.agents?.defaults?.memorySearch,
            provider: "local",
          },
        },
      },
    };
    return offerKBImport(localResult, prompter, isClawMongo, trimmedUri);
  }

  const ENV_VAR_MAP: Record<string, string> = {
    voyage: "VOYAGE_API_KEY",
    openai: "OPENAI_API_KEY",
    gemini: "GEMINI_API_KEY",
  };
  const envVar = ENV_VAR_MAP[embeddingProvider] ?? "API_KEY";

  const rawKey = await prompter.text({
    message: envVar,
    placeholder: "sk-... (leave blank if already set as env var)",
    validate: () => undefined,
  });
  const apiKey = rawKey?.trim() || undefined;

  if (!apiKey) {
    await prompter.note(
      `Set ${envVar} in your environment before starting the gateway.`,
      "Reminder",
    );
  }

  const finalResult: OpenClawConfig = {
    ...baseResult,
    agents: {
      ...baseResult.agents,
      defaults: {
        ...baseResult.agents?.defaults,
        memorySearch: {
          ...baseResult.agents?.defaults?.memorySearch,
          provider: embeddingProvider,
          ...(apiKey
            ? { remote: { ...baseResult.agents?.defaults?.memorySearch?.remote, apiKey } }
            : {}),
        },
      },
    },
  };
  return offerKBImport(finalResult, prompter, isClawMongo, trimmedUri);
}

// ---------------------------------------------------------------------------
// KB Import Step (offered after MongoDB setup)
// ---------------------------------------------------------------------------

async function offerKBImport(
  config: OpenClawConfig,
  prompter: WizardPrompter,
  isClawMongo: boolean,
  uri: string,
): Promise<OpenClawConfig> {
  const cliName = isClawMongo ? "clawmongo" : "openclaw";
  const wantImport = await prompter.select({
    message: "Do you have documents to import into the knowledge base?",
    options: [
      {
        value: "skip" as const,
        label: "Skip for now",
        hint: `Import later with: ${cliName} kb ingest <path>`,
      },
      {
        value: "import" as const,
        label: "Yes, import files/directory",
        hint: "Import .md and .txt files",
      },
    ],
    initialValue: "skip" as const,
  });

  if (wantImport !== "import") {
    return config;
  }

  const importPath = await prompter.text({
    message: "Path to files or directory to import",
    placeholder: "./docs",
    validate: (value) => {
      if (!value.trim()) {
        return "Path is required";
      }
      return undefined;
    },
  });

  const resolvedPath = path.resolve(importPath.trim());
  const tags = await prompter.text({
    message: "Tags (comma-separated, or leave blank)",
    placeholder: "docs, reference",
  });
  const tagList = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const progress = prompter.progress("Importing documents…");

  let importSucceeded = false;
  let client: import("mongodb").MongoClient | undefined;
  try {
    const { MongoClient } = await import("mongodb");
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
    });
    await client.connect();

    const mongoCfg = config.memory?.mongodb;
    const database = mongoCfg?.database ?? "openclaw";
    const prefix = mongoCfg?.collectionPrefix ?? "openclaw_";
    const db = client.db(database);

    const { ensureCollections, ensureStandardIndexes } =
      await import("../memory/mongodb-schema.js");
    await ensureCollections(db, prefix);
    await ensureStandardIndexes(db, prefix);

    const { ingestFilesToKB } = await import("../memory/mongodb-kb.js");
    const embeddingMode = mongoCfg?.embeddingMode ?? "automated";

    const result = await ingestFilesToKB({
      db,
      prefix,
      paths: [resolvedPath],
      recursive: true,
      tags: tagList.length > 0 ? tagList : undefined,
      importedBy: "wizard",
      embeddingMode,
      progress: (p) => {
        progress.update(`${p.completed}/${p.total}: ${p.label}`);
      },
    });

    progress.stop(
      `Imported ${result.documentsProcessed} documents (${result.chunksCreated} chunks, ${result.skipped} skipped)`,
    );

    if (result.errors.length > 0) {
      await prompter.note(result.errors.map((e) => `- ${e}`).join("\n"), "Import Warnings");
    }

    importSucceeded = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    progress.stop(`Import failed: ${msg}`);
    await prompter.note(
      `You can import later with: ${cliName} kb ingest ${resolvedPath}`,
      "Import Failed",
    );
  } finally {
    await client?.close().catch(() => {});
  }

  // Store autoImportPaths in config only when import succeeded
  if (!importSucceeded) {
    return config;
  }
  return {
    ...config,
    memory: {
      ...config.memory,
      mongodb: {
        ...config.memory?.mongodb,
        kb: {
          ...config.memory?.mongodb?.kb,
          autoImportPaths: [...(config.memory?.mongodb?.kb?.autoImportPaths ?? []), resolvedPath],
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Workspace Customization for MongoDB Backend
// ---------------------------------------------------------------------------

const MONGODB_AGENTS_SECTION = `

## MongoDB Memory Backend

This workspace uses the MongoDB memory backend. The agent should prefer MongoDB tools over file-based patterns:

- **Recall**: Use \`memory_search\` (not file reads) as the primary recall mechanism
- **Store**: Use \`memory_write\` for structured data (decisions, preferences, facts)
- **Reference**: Use \`kb_search\` for imported documents and reference materials
- **MEMORY.md**: Use for informal scratch notes only — NOT your primary memory

The MongoDB backend provides persistent, searchable, multi-instance memory with vector search,
knowledge base ingestion, and structured agent memory.
`;

const MONGODB_MEMORY_SEED = `# Memory Notes

This workspace uses the MongoDB memory backend.

- Use \`memory_search\` for recall (not file reads)
- Use \`memory_write\` for structured data (decisions, preferences, facts)
- Use \`kb_search\` for reference documents
- This file is for informal scratch notes only
`;

/**
 * Customize workspace files for the MongoDB memory backend.
 * - Appends a MongoDB section to AGENTS.md (idempotent)
 * - Seeds MEMORY.md with correct initial content (does not overwrite)
 */
export async function customizeWorkspaceForMongoDB(workspaceDir: string): Promise<void> {
  const agentsPath = path.join(workspaceDir, DEFAULT_AGENTS_FILENAME);
  const memoryPath = path.join(workspaceDir, DEFAULT_MEMORY_FILENAME);

  // --- AGENTS.md: append MongoDB section (idempotent) ---
  try {
    const existing = await fs.readFile(agentsPath, "utf-8");
    if (!existing.includes("## MongoDB Memory Backend")) {
      await fs.appendFile(agentsPath, MONGODB_AGENTS_SECTION);
    }
  } catch {
    // AGENTS.md doesn't exist or can't be read — skip
  }

  // --- MEMORY.md: seed with MongoDB-aware content (exclusive create) ---
  try {
    await fs.writeFile(memoryPath, MONGODB_MEMORY_SEED, { flag: "wx" });
  } catch (err) {
    // EEXIST is expected — file already exists, don't overwrite
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      // Re-throw unexpected errors (but caller wraps in try/catch anyway)
      throw err;
    }
  }
}
