import type { Command } from "commander";
import path from "node:path";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { setVerbose } from "../globals.js";
import { resolveMemoryBackendConfig } from "../memory/backend-config.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { formatErrorMessage } from "./cli-utils.js";
import { withProgressTotals } from "./progress.js";

type KBCommandOptions = {
  agent?: string;
  json?: boolean;
  verbose?: boolean;
};

function resolveAgent(cfg: ReturnType<typeof loadConfig>, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) {
    return trimmed;
  }
  return resolveDefaultAgentId(cfg);
}

/** Connect to MongoDB using config, returning { client, db, prefix } or null. */
async function connectMongoDB(cfg: ReturnType<typeof loadConfig>, agentId: string) {
  const resolved = resolveMemoryBackendConfig({ cfg, agentId });
  const mongoCfg = resolved.mongodb;
  if (!mongoCfg) {
    defaultRuntime.error(
      'KB commands require MongoDB backend. Set memory.backend = "mongodb" in config.',
    );
    return null;
  }

  let MongoClient: typeof import("mongodb").MongoClient;
  try {
    ({ MongoClient } = await import("mongodb"));
  } catch {
    defaultRuntime.error("MongoDB driver is not installed. Install with: pnpm add mongodb");
    return null;
  }

  const client = new MongoClient(mongoCfg.uri, {
    serverSelectionTimeoutMS: mongoCfg.connectTimeoutMs,
    connectTimeoutMS: mongoCfg.connectTimeoutMs,
    maxPoolSize: mongoCfg.maxPoolSize,
    minPoolSize: mongoCfg.minPoolSize,
  });

  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    defaultRuntime.error(`MongoDB connection failed: ${msg}`);
    try {
      await client.close();
    } catch {
      // Ignore close errors
    }
    return null;
  }

  return {
    client,
    db: client.db(mongoCfg.database),
    prefix: mongoCfg.collectionPrefix,
    mongoCfg,
  };
}

export function registerKBCli(program: Command) {
  const kb = program
    .command("kb")
    .description("Knowledge base management (MongoDB)")
    .addHelpText(
      "after",
      () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/kb", "docs.openclaw.ai/cli/kb")}\n`,
    );

  // -----------------------------------------------------------------------
  // kb ingest <path>
  // -----------------------------------------------------------------------
  kb.command("ingest")
    .description("Import files into the knowledge base")
    .argument("<paths...>", "File or directory paths to import")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--tags <tags>", "Comma-separated tags", (val: string) =>
      val
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    )
    .option("--category <cat>", "Category for imported documents")
    .option("--force", "Re-import even if content hash matches", false)
    .option("--no-recursive", "Do not recurse into subdirectories")
    .option("--verbose", "Verbose logging", false)
    .action(
      async (
        paths: string[],
        opts: KBCommandOptions & {
          tags?: string[];
          category?: string;
          force?: boolean;
          recursive?: boolean;
        },
      ) => {
        setVerbose(Boolean(opts.verbose));
        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        const conn = await connectMongoDB(cfg, agentId);
        if (!conn) {
          process.exitCode = 1;
          return;
        }

        const { client, db, prefix, mongoCfg } = conn;
        try {
          const resolvedPaths = paths.map((p) => path.resolve(p));

          // Optionally set up an embedding provider for managed mode
          let embeddingProvider: import("../memory/embeddings.js").EmbeddingProvider | undefined;
          if (mongoCfg.embeddingMode === "managed") {
            try {
              const { createEmbeddingProvider } = await import("../memory/embeddings.js");
              const { resolveMemorySearchConfig } = await import("../agents/memory-search.js");
              const settings = resolveMemorySearchConfig(cfg, agentId);
              if (settings) {
                const { resolveAgentDir } = await import("../agents/agent-scope.js");
                const result = await createEmbeddingProvider({
                  config: cfg,
                  agentDir: resolveAgentDir(cfg, agentId),
                  provider: settings.provider,
                  remote: settings.remote,
                  model: settings.model,
                  fallback: settings.fallback,
                  local: settings.local,
                });
                embeddingProvider = result.provider;
              }
            } catch {
              defaultRuntime.log(
                "Note: embedding provider unavailable — importing without vector embeddings. Text search will still work.",
              );
            }
          }

          const { ingestFilesToKB } = await import("../memory/mongodb-kb.js");
          let result: Awaited<ReturnType<typeof ingestFilesToKB>>;

          await withProgressTotals({ label: "Importing documents…", total: 0 }, async (update) => {
            result = await ingestFilesToKB({
              db,
              prefix,
              paths: resolvedPaths,
              recursive: opts.recursive !== false,
              tags: opts.tags,
              category: opts.category,
              importedBy: "cli",
              embeddingMode: mongoCfg.embeddingMode,
              embeddingProvider,
              chunking: mongoCfg.kb.chunking,
              force: opts.force,
              progress: (p) => {
                update({ completed: p.completed, total: p.total, label: p.label });
              },
            });
          });

          const rich = isRich();
          const lines = [
            `${colorize(rich, theme.success, "KB ingest complete")}`,
            `  Documents processed: ${result!.documentsProcessed}`,
            `  Chunks created: ${result!.chunksCreated}`,
            `  Skipped (already imported): ${result!.skipped}`,
          ];
          if (result!.errors.length > 0) {
            lines.push(`  Errors: ${result!.errors.length}`);
            for (const err of result!.errors) {
              lines.push(`    ${colorize(rich, theme.warn, err)}`);
            }
          }
          defaultRuntime.log(lines.join("\n"));
        } catch (err) {
          defaultRuntime.error(`KB ingest failed: ${formatErrorMessage(err)}`);
          process.exitCode = 1;
        } finally {
          await client.close().catch(() => {});
        }
      },
    );

  // -----------------------------------------------------------------------
  // kb list
  // -----------------------------------------------------------------------
  kb.command("list")
    .description("List knowledge base documents")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--category <cat>", "Filter by category")
    .option("--tags <tags>", "Filter by tags (comma-separated)", (val: string) =>
      val
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    )
    .option("--json", "Print JSON")
    .action(
      async (
        opts: KBCommandOptions & {
          category?: string;
          tags?: string[];
        },
      ) => {
        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        const conn = await connectMongoDB(cfg, agentId);
        if (!conn) {
          process.exitCode = 1;
          return;
        }

        const { client, db, prefix } = conn;
        try {
          const { listKBDocuments } = await import("../memory/mongodb-kb.js");
          const docs = await listKBDocuments(db, prefix, {
            category: opts.category,
            tags: opts.tags,
          });

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(docs, null, 2));
            return;
          }

          if (docs.length === 0) {
            defaultRuntime.log("No documents in knowledge base.");
            return;
          }

          const rich = isRich();
          const lines: string[] = [
            `${colorize(rich, theme.heading, "Knowledge Base")} ${colorize(rich, theme.muted, `(${docs.length} documents)`)}`,
            "",
          ];
          for (const doc of docs) {
            const tags = doc.tags.length > 0 ? ` [${doc.tags.join(", ")}]` : "";
            const cat = doc.category ? ` (${doc.category})` : "";
            const sourcePath =
              doc.source?.path && typeof doc.source.path === "string"
                ? shortenHomePath(doc.source.path)
                : "";
            lines.push(
              `${colorize(rich, theme.accent, doc._id)} ${colorize(rich, theme.info, doc.title)}${cat}${tags}`,
            );
            lines.push(
              `  ${colorize(rich, theme.muted, `${doc.chunkCount} chunks · ${sourcePath} · ${doc.updatedAt.toISOString()}`)}`,
            );
          }
          defaultRuntime.log(lines.join("\n"));
        } catch (err) {
          defaultRuntime.error(`KB list failed: ${formatErrorMessage(err)}`);
          process.exitCode = 1;
        } finally {
          await client.close().catch(() => {});
        }
      },
    );

  // -----------------------------------------------------------------------
  // kb search <query>
  // -----------------------------------------------------------------------
  kb.command("search")
    .description("Search the knowledge base")
    .argument("<query>", "Search query")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (val: string) => Number(val))
    .option("--json", "Print JSON")
    .action(async (query: string, opts: KBCommandOptions & { maxResults?: number }) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      const conn = await connectMongoDB(cfg, agentId);
      if (!conn) {
        process.exitCode = 1;
        return;
      }

      const { client, db, prefix, mongoCfg } = conn;
      try {
        const { detectCapabilities, kbChunksCollection } =
          await import("../memory/mongodb-schema.js");
        const { searchKB } = await import("../memory/mongodb-kb-search.js");

        const capabilities = await detectCapabilities(db);
        const maxResults = opts.maxResults ?? 10;

        // Generate query embedding for managed mode
        let queryVector: number[] | null = null;
        if (mongoCfg.embeddingMode === "managed") {
          try {
            const { createEmbeddingProvider } = await import("../memory/embeddings.js");
            const { resolveMemorySearchConfig } = await import("../agents/memory-search.js");
            const settings = resolveMemorySearchConfig(cfg, agentId);
            if (settings) {
              const { resolveAgentDir } = await import("../agents/agent-scope.js");
              const result = await createEmbeddingProvider({
                config: cfg,
                agentDir: resolveAgentDir(cfg, agentId),
                provider: settings.provider,
                remote: settings.remote,
                model: settings.model,
                fallback: settings.fallback,
                local: settings.local,
              });
              queryVector = await result.provider.embedQuery(query);
            }
          } catch {
            defaultRuntime.log(
              "Note: embedding provider unavailable — falling back to text search only.",
            );
          }
        }

        const results = await searchKB(kbChunksCollection(db, prefix), query, queryVector, {
          maxResults,
          minScore: 0.1,
          vectorIndexName: `${prefix}kb_chunks_vector`,
          textIndexName: `${prefix}kb_chunks_text`,
          capabilities,
          embeddingMode: mongoCfg.embeddingMode,
        });

        if (opts.json) {
          defaultRuntime.log(JSON.stringify({ results }, null, 2));
          return;
        }

        if (results.length === 0) {
          defaultRuntime.log("No matches.");
          return;
        }

        const rich = isRich();
        const lines: string[] = [];
        for (const result of results) {
          lines.push(
            `${colorize(rich, theme.success, result.score.toFixed(3))} ${colorize(
              rich,
              theme.accent,
              `${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`,
            )}`,
          );
          lines.push(colorize(rich, theme.muted, result.snippet));
          lines.push("");
        }
        defaultRuntime.log(lines.join("\n").trim());
      } catch (err) {
        defaultRuntime.error(`KB search failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      } finally {
        await client.close().catch(() => {});
      }
    });

  // -----------------------------------------------------------------------
  // kb stats
  // -----------------------------------------------------------------------
  kb.command("stats")
    .description("Show knowledge base statistics")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .action(async (opts: KBCommandOptions) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      const conn = await connectMongoDB(cfg, agentId);
      if (!conn) {
        process.exitCode = 1;
        return;
      }

      const { client, db, prefix } = conn;
      try {
        const { getKBStats } = await import("../memory/mongodb-kb.js");
        const stats = await getKBStats(db, prefix);

        if (opts.json) {
          defaultRuntime.log(JSON.stringify(stats, null, 2));
          return;
        }

        const rich = isRich();
        const label = (text: string) => colorize(rich, theme.muted, `${text}:`);
        const lines = [
          colorize(rich, theme.heading, "Knowledge Base Stats"),
          `${label("Documents")} ${colorize(rich, theme.info, String(stats.documents))}`,
          `${label("Chunks")} ${colorize(rich, theme.info, String(stats.chunks))}`,
          `${label("Categories")} ${colorize(rich, theme.info, stats.categories.length > 0 ? stats.categories.join(", ") : "(none)")}`,
          `${label("Sources")} ${colorize(
            rich,
            theme.info,
            Object.entries(stats.sources)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ") || "(none)",
          )}`,
        ];
        defaultRuntime.log(lines.join("\n"));
      } catch (err) {
        defaultRuntime.error(`KB stats failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      } finally {
        await client.close().catch(() => {});
      }
    });

  // -----------------------------------------------------------------------
  // kb remove <id>
  // -----------------------------------------------------------------------
  kb.command("remove")
    .description("Remove a document from the knowledge base")
    .argument("<id>", "Document ID to remove")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--yes", "Skip confirmation", false)
    .action(async (docId: string, opts: KBCommandOptions & { yes?: boolean }) => {
      const cfg = loadConfig();
      const agentId = resolveAgent(cfg, opts.agent);
      const conn = await connectMongoDB(cfg, agentId);
      if (!conn) {
        process.exitCode = 1;
        return;
      }

      const { client, db, prefix } = conn;
      try {
        if (!opts.yes) {
          const { confirm } = await import("@clack/prompts");
          const shouldRemove = await confirm({
            message: `Remove document ${docId} from the knowledge base?`,
          });
          if (!shouldRemove || typeof shouldRemove === "symbol") {
            defaultRuntime.log("Cancelled.");
            return;
          }
        }

        const { removeKBDocument } = await import("../memory/mongodb-kb.js");
        const removed = await removeKBDocument(db, prefix, docId);

        if (removed) {
          defaultRuntime.log(`Removed document ${docId} and its chunks.`);
        } else {
          defaultRuntime.log(`Document ${docId} not found.`);
          process.exitCode = 1;
        }
      } catch (err) {
        defaultRuntime.error(`KB remove failed: ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      } finally {
        await client.close().catch(() => {});
      }
    });
}
