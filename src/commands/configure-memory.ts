import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { MemoryMongoDBDeploymentProfile } from "../config/types.memory.js";
import type { RuntimeEnv } from "../runtime.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveOpenClawPackageName } from "../infra/openclaw-root.js";
import { note } from "../terminal/note.js";
import { confirm, select, text } from "./configure.shared.js";
import { guardCancel } from "./onboard-helpers.js";

/**
 * Memory backend section for the configure wizard.
 * Shows current backend, allows switching, and configures MongoDB settings.
 */
export async function configureMemorySection(
  nextConfig: OpenClawConfig,
  runtime: RuntimeEnv,
): Promise<OpenClawConfig> {
  const packageName = await resolveOpenClawPackageName();
  const isClawMongo = packageName === "@romiluz/clawmongo";
  const currentBackend = nextConfig.memory?.backend ?? "builtin";

  note(
    [
      `Current memory backend: ${currentBackend}`,
      ...(currentBackend === "mongodb" && nextConfig.memory?.mongodb?.uri
        ? [`MongoDB URI: ${redactUri(nextConfig.memory.mongodb.uri)}`]
        : []),
      ...(currentBackend === "mongodb" && nextConfig.memory?.mongodb?.deploymentProfile
        ? [`Profile: ${nextConfig.memory.mongodb.deploymentProfile}`]
        : []),
    ].join("\n"),
    "Memory",
  );

  const backend = guardCancel(
    await select({
      message: "Memory backend",
      options: [
        {
          value: "builtin",
          label: "Built-in (SQLite)",
          hint: "Default. Works everywhere, no setup needed.",
        },
        {
          value: "mongodb",
          label: isClawMongo ? "MongoDB (Recommended)" : "MongoDB",
          hint: isClawMongo
            ? "ACID transactions, vector search, TTL, analytics, change streams."
            : "Scalable. Requires MongoDB 8.0+ connection.",
        },
        {
          value: "qmd",
          label: "QMD",
          hint: "Advanced. Local semantic search with qmd binary.",
        },
      ],
      initialValue: currentBackend,
    }),
    runtime,
  );

  if (backend === "builtin") {
    return {
      ...nextConfig,
      memory: { ...nextConfig.memory, backend: "builtin" },
    };
  }

  if (backend === "qmd") {
    return {
      ...nextConfig,
      memory: { ...nextConfig.memory, backend: "qmd" },
    };
  }

  // MongoDB configuration
  const existingUri = nextConfig.memory?.mongodb?.uri ?? "";
  const uriInput = guardCancel(
    await text({
      message: existingUri
        ? "MongoDB connection URI (leave blank to keep current)"
        : "MongoDB connection URI",
      placeholder: "mongodb+srv://user:pass@cluster.mongodb.net/",
      validate: (value) => {
        const trimmed = (value ?? "").trim();
        if (!trimmed && existingUri) {
          return undefined;
        } // keep existing
        if (!trimmed) {
          return "URI is required for MongoDB backend";
        }
        if (!trimmed.startsWith("mongodb://") && !trimmed.startsWith("mongodb+srv://")) {
          return "URI must start with mongodb:// or mongodb+srv://";
        }
        return undefined;
      },
    }),
    runtime,
  );

  const uri = String(uriInput ?? "").trim() || existingUri;
  const isAtlas = uri.includes(".mongodb.net");
  const currentProfile = nextConfig.memory?.mongodb?.deploymentProfile;
  const suggestedProfile: MemoryMongoDBDeploymentProfile =
    currentProfile ?? (isAtlas ? "atlas-default" : "community-mongot");

  const profile = guardCancel(
    await select({
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
    }),
    runtime,
  );

  // Auto-set embeddingMode based on profile
  const isCommunity = profile === "community-mongot" || profile === "community-bare";
  const embeddingMode = isCommunity ? "managed" : "automated";

  let baseResult: OpenClawConfig = {
    ...nextConfig,
    memory: {
      ...nextConfig.memory,
      backend: "mongodb",
      mongodb: {
        ...nextConfig.memory?.mongodb,
        uri,
        deploymentProfile: profile as MemoryMongoDBDeploymentProfile,
        embeddingMode,
      },
    },
  };

  if (isCommunity) {
    if (profile === "community-bare") {
      note(
        [
          "Text/keyword search via $text is available out of the box.",
          "Vector/semantic search requires mongot (Community + mongot profile).",
        ].join("\n"),
        "Search Capabilities",
      );
    } else {
      // community-mongot: vector search available with managed embeddings
      const wantVectorSearch = guardCancel(
        await confirm({
          message: "Enable vector/semantic search? (requires an embedding API key)",
          initialValue: true,
        }),
        runtime,
      );

      if (wantVectorSearch) {
        const embeddingProvider = guardCancel(
          await select({
            message: "Embedding provider for vector search",
            options: [
              { value: "voyage", label: "Voyage AI", hint: "Best for code retrieval" },
              { value: "openai", label: "OpenAI", hint: "text-embedding-3-small" },
              { value: "gemini", label: "Google Gemini", hint: "text-embedding-004" },
              {
                value: "local",
                label: "Local (no API key needed)",
                hint: "On-device via node-llama-cpp",
              },
            ],
            initialValue: "voyage",
          }),
          runtime,
        );

        if (embeddingProvider === "local") {
          baseResult = {
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
        } else {
          const ENV_VAR_MAP: Record<string, string> = {
            voyage: "VOYAGE_API_KEY",
            openai: "OPENAI_API_KEY",
            gemini: "GEMINI_API_KEY",
          };
          const envVar = ENV_VAR_MAP[embeddingProvider] ?? "API_KEY";

          const rawKey = guardCancel(
            await text({
              message: envVar,
              placeholder: "sk-... (leave blank if already set as env var)",
              validate: () => undefined,
            }),
            runtime,
          );
          const apiKey = String(rawKey ?? "").trim() || undefined;

          if (!apiKey) {
            note(`Set ${envVar} in your environment before starting the gateway.`, "Reminder");
          }

          baseResult = {
            ...baseResult,
            agents: {
              ...baseResult.agents,
              defaults: {
                ...baseResult.agents?.defaults,
                memorySearch: {
                  ...baseResult.agents?.defaults?.memorySearch,
                  provider: embeddingProvider as "openai" | "gemini" | "voyage",
                  ...(apiKey
                    ? { remote: { ...baseResult.agents?.defaults?.memorySearch?.remote, apiKey } }
                    : {}),
                },
              },
            },
          };
        }
      } else {
        note(
          [
            "Text search will work out of the box.",
            `Enable later: openclaw configure → Memory`,
          ].join("\n"),
          "Text Search Only",
        );
      }
    }
  }

  // Offer connection test
  const shouldTest = guardCancel(
    await confirm({
      message: "Test MongoDB connection now?",
      initialValue: true,
    }),
    runtime,
  );

  if (shouldTest) {
    await testMongoDBConnection(uri);
  }

  // Offer KB import (only for MongoDB backend)
  return offerKBImportConfigure(baseResult, runtime, isClawMongo, uri);
}

async function testMongoDBConnection(uri: string): Promise<void> {
  let MongoClient: typeof import("mongodb").MongoClient;
  try {
    ({ MongoClient } = await import("mongodb"));
  } catch {
    note(
      [
        "MongoDB driver is not installed.",
        "",
        "The configuration will be saved anyway.",
        "Install with: pnpm add mongodb",
        `Verify later: ${formatCliCommand("openclaw doctor")}`,
      ].join("\n"),
      "Memory",
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
    note("MongoDB connection successful.", "Memory");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    note(
      [
        `MongoDB connection failed: ${message}`,
        "",
        "The configuration will be saved anyway.",
        `Verify later: ${formatCliCommand("openclaw doctor")}`,
      ].join("\n"),
      "Memory",
    );
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// KB Import Step (offered after MongoDB configuration)
// ---------------------------------------------------------------------------

async function offerKBImportConfigure(
  config: OpenClawConfig,
  runtime: RuntimeEnv,
  isClawMongo: boolean,
  uri: string,
): Promise<OpenClawConfig> {
  const cliName = isClawMongo ? "clawmongo" : "openclaw";
  const wantImport = guardCancel(
    await select({
      message: "Import documents into the knowledge base?",
      options: [
        {
          value: "skip",
          label: "Skip for now",
          hint: `Import later with: ${cliName} kb ingest <path>`,
        },
        {
          value: "import",
          label: "Yes, import files/directory",
          hint: "Import .md and .txt files",
        },
      ],
      initialValue: "skip",
    }),
    runtime,
  );

  if (wantImport !== "import") {
    return config;
  }

  const importPathInput = guardCancel(
    await text({
      message: "Path to files or directory to import",
      placeholder: "./docs",
      validate: (value) => {
        if (!(value ?? "").trim()) {
          return "Path is required";
        }
        return undefined;
      },
    }),
    runtime,
  );

  const resolvedPath = path.resolve(String(importPathInput).trim());
  const tagsInput = guardCancel(
    await text({
      message: "Tags (comma-separated, or leave blank)",
      placeholder: "docs, reference",
      validate: () => undefined,
    }),
    runtime,
  );
  const tagList = String(tagsInput ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

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

    note("Importing documents…", "Knowledge Base");

    const result = await ingestFilesToKB({
      db,
      prefix,
      paths: [resolvedPath],
      recursive: true,
      tags: tagList.length > 0 ? tagList : undefined,
      importedBy: "wizard",
      embeddingMode,
    });

    note(
      `Imported ${result.documentsProcessed} documents (${result.chunksCreated} chunks, ${result.skipped} skipped)`,
      "Knowledge Base",
    );

    if (result.errors.length > 0) {
      note(result.errors.map((e) => `- ${e}`).join("\n"), "Import Warnings");
    }

    importSucceeded = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    note(
      [
        `Import failed: ${msg}`,
        "",
        `You can import later with: ${cliName} kb ingest ${resolvedPath}`,
      ].join("\n"),
      "Knowledge Base",
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

function redactUri(uri: string): string {
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
