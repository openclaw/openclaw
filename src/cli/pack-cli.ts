import type { Command } from "commander";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

/**
 * Register the pack CLI commands.
 */
export function registerPackCli(program: Command) {
  const pack = program
    .command("pack")
    .description("Manage Agent Packs — shareable workspace templates")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/pack", "docs.openclaw.ai/cli/pack")}\n`,
    );

  pack
    .command("info")
    .description("Show pack details from a directory")
    .argument("<path>", "Path to pack directory")
    .option("--json", "Output as JSON", false)
    .action(async (packPath: string, opts: { json: boolean }) => {
      try {
        const { resolvePack } = await import("../agents/pack/resolve.js");
        const entry = await resolvePack(packPath);
        if (!entry) {
          defaultRuntime.error(`No valid pack found at ${packPath}`);
          defaultRuntime.exit(1);
          return;
        }
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(entry.metadata, null, 2));
          return;
        }
        const lines: string[] = [];
        lines.push(`${theme.heading("Pack:")} ${entry.metadata.name}`);
        if (entry.metadata.description) {
          lines.push(`${theme.muted("Description:")} ${entry.metadata.description}`);
        }
        if (entry.metadata.author) {
          lines.push(`${theme.muted("Author:")} ${entry.metadata.author}`);
        }
        if (entry.metadata.version) {
          lines.push(`${theme.muted("Version:")} ${entry.metadata.version}`);
        }
        if (entry.metadata.skills?.length) {
          lines.push(`${theme.muted("Skills:")} ${entry.metadata.skills.join(", ")}`);
        }
        if (entry.metadata.tags?.length) {
          lines.push(`${theme.muted("Tags:")} ${entry.metadata.tags.join(", ")}`);
        }
        lines.push("");
        lines.push(
          `${theme.muted("Workspace files:")} ${entry.workspaceFiles.join(", ") || "(none)"}`,
        );
        lines.push(
          `${theme.muted("Template files:")} ${entry.templateFiles.join(", ") || "(none)"}`,
        );
        lines.push(
          `${theme.muted("Bundled skills:")} ${entry.bundledSkillDirs.join(", ") || "(none)"}`,
        );
        lines.push("");
        lines.push(`${theme.muted("Path:")} ${entry.dir}`);
        defaultRuntime.log(lines.join("\n"));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  pack
    .command("install")
    .description("Install a pack into a workspace")
    .argument("<path>", "Path to pack directory")
    .option("-w, --workdir <dir>", "Target workspace directory")
    .option("-f, --force", "Overwrite existing files", false)
    .option("--skip-skills", "Skip skill dependency installation", false)
    .action(
      async (packPath: string, opts: { workdir?: string; force: boolean; skipSkills: boolean }) => {
        try {
          const { installPack } = await import("../agents/pack/install.js");
          const result = await installPack(packPath, {
            workdir: opts.workdir,
            force: opts.force,
            skipSkills: opts.skipSkills,
          });

          if (!result.ok) {
            for (const err of result.errors) {
              defaultRuntime.error(err);
            }
            defaultRuntime.exit(1);
            return;
          }

          const lines: string[] = [];
          lines.push(`${theme.success("✔")} Pack installed to ${result.workspaceDir}`);
          if (result.copiedFiles.length > 0) {
            lines.push(`  ${theme.muted("Copied:")} ${result.copiedFiles.join(", ")}`);
          }
          if (result.skippedFiles.length > 0) {
            lines.push(`  ${theme.muted("Skipped (exists):")} ${result.skippedFiles.join(", ")}`);
          }
          if (result.installedSkills.length > 0) {
            lines.push(`  ${theme.muted("Skills:")} ${result.installedSkills.join(", ")}`);
          }
          defaultRuntime.log(lines.join("\n"));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      },
    );

  pack
    .command("init")
    .description("Export current workspace as a pack")
    .option("-n, --name <name>", "Pack name (required)")
    .option("-o, --output <dir>", "Output directory for the pack")
    .option("-a, --author <author>", "Pack author")
    .option("--description <desc>", "Pack description")
    .option("-v, --version <version>", "Pack version", "1.0.0")
    .option("--include-skills", "Include skills directory", false)
    .action(
      async (opts: {
        name?: string;
        output?: string;
        author?: string;
        description?: string;
        version: string;
        includeSkills: boolean;
      }) => {
        if (!opts.name) {
          defaultRuntime.error("Pack name is required. Use --name <name>");
          defaultRuntime.exit(1);
          return;
        }
        try {
          const { initPack } = await import("../agents/pack/init.js");
          const result = await initPack(process.cwd(), {
            name: opts.name,
            outputDir: opts.output,
            description: opts.description,
            author: opts.author,
            version: opts.version,
            includeSkills: opts.includeSkills,
          });

          if (!result.ok) {
            for (const err of result.errors) {
              defaultRuntime.error(err);
            }
            defaultRuntime.exit(1);
            return;
          }

          const lines: string[] = [];
          lines.push(`${theme.success("✔")} Pack "${opts.name}" created at ${result.packDir}`);
          if (result.files.length > 0) {
            lines.push(`  ${theme.muted("Files:")} ${result.files.join(", ")}`);
          }
          defaultRuntime.log(lines.join("\n"));
        } catch (err) {
          defaultRuntime.error(String(err));
          defaultRuntime.exit(1);
        }
      },
    );

  pack
    .command("list")
    .description("List available packs from a directory")
    .argument("[dir]", "Directory to scan for packs", ".")
    .option("--json", "Output as JSON", false)
    .action(async (dir: string, opts: { json: boolean }) => {
      try {
        const { scanPacksDir } = await import("../agents/pack/resolve.js");
        const packs = await scanPacksDir(dir);

        if (opts.json) {
          defaultRuntime.log(
            JSON.stringify(
              packs.map((p) => p.metadata),
              null,
              2,
            ),
          );
          return;
        }

        if (packs.length === 0) {
          defaultRuntime.log(theme.muted("No packs found."));
          return;
        }

        const lines: string[] = [];
        for (const pack of packs) {
          const desc = pack.metadata.description ? ` — ${pack.metadata.description}` : "";
          const ver = pack.metadata.version ? ` (${pack.metadata.version})` : "";
          lines.push(`  ${theme.heading(pack.metadata.name)}${ver}${theme.muted(desc)}`);
        }
        defaultRuntime.log(lines.join("\n"));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // Default action (no subcommand) — show help
  pack.action(() => {
    pack.outputHelp();
  });
}
