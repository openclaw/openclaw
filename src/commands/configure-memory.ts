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

  return {
    ...nextConfig,
    memory: {
      ...nextConfig.memory,
      backend: "mongodb",
      mongodb: {
        ...nextConfig.memory?.mongodb,
        uri,
        deploymentProfile: profile as MemoryMongoDBDeploymentProfile,
      },
    },
  };
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
