import type { Command } from "commander";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

export async function runMemoryStatus(opts: {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  force?: boolean;
  verbose?: boolean;
}) {
  const impl = await import("./memory-cli-impl.js");
  return impl.runMemoryStatusImpl(opts);
}

export function registerMemoryCli(program: Command) {
  const memory = program
    .command("memory")
    .description("Memory search tools")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.openclaw.ai/cli/memory")}\n`,
    );

  memory
    .command("status")
    .description("Show memory search index status")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .option("--deep", "Probe embedding provider availability")
    .option("--index", "Reindex if dirty (implies --deep)")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts) => {
      const { runMemoryStatusImpl: run } = await import("./memory-cli-impl.js");
      await run(opts);
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts) => {
      const { runMemoryIndex } = await import("./memory-cli-impl.js");
      await runMemoryIndex(opts);
    });

  memory
    .command("search")
    .description("Search memory files")
    .argument("<query>", "Search query")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(async (query: string, opts) => {
      const { runMemorySearch } = await import("./memory-cli-impl.js");
      await runMemorySearch(query, opts);
    });
}
