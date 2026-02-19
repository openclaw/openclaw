import type { Command } from "commander";
import { buildResearchDocFromInput } from "../lib/section-extractors.js";
import { defaultRuntime } from "../runtime.js";
import { runCommandWithRuntime } from "./cli-utils.js";
import { formatCliCommand } from "./command-format.js";
import { runInteractiveResearchChat } from "./research-chat-interactive.js";

export function registerResearchCommand(program: Command) {
  program
    .command("research")
    .description("Interactive research assistant and template-driven research exporter")
    .option("--chat", "Start interactive LLM-powered research chatbot", false)
    .option("--wizard", "Run interactive wizard to build a research doc", false)
    .option("--template <name>", "Start from a named template: brief|design|postmortem")
    .option("--from-file <path>", "Read input from a file")
    .option("--sectioned", "Output sectioned JSON along with Markdown", false)
    .option("--no-llm", "Disable LLM fallback (heading/heuristic only)")
    .option("--output <file>", "Write Markdown/JSON to file")
    .addHelpText(
      "after",
      () =>
        `\nExamples:\n  ${formatCliCommand("openclaw research --chat")}  # chatbot mode\n  ${formatCliCommand("openclaw research --wizard")}  # interactive wizard\n  ${formatCliCommand(
          "openclaw research --from-file notes.md --sectioned --output research.md",
        )}\n`,
    )
    .action(async (opts) => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        // Chat mode: interactive LLM-powered research assistant
        if (opts.chat) {
          await runInteractiveResearchChat(defaultRuntime, {
            template: opts.template,
            outputPath: opts.output,
          });
          return;
        }

        let input = "";
        if (opts.fromFile) {
          // lazy import to keep startup fast
          const fs = await import("fs/promises");
          input = String(await fs.readFile(opts.fromFile, "utf8"));
        }

        if (opts.wizard) {
          // Minimal interactive wizard for Phase 1 (readline fallback)
          const rlMod = await import("readline/promises");
          const { stdin: inputStream, stdout: outputStream } = process;
          const rl = rlMod.createInterface({ input: inputStream, output: outputStream });
          const title = (await rl.question("Title (short): ")).trim() || "Untitled research";
          const summary = (await rl.question("One-line summary (optional): ")).trim();
          outputStream.write("Paste notes / background (end with an empty line, then Ctrl+D):\n");
          // simple multiline capture until EOF
          let body = "";
          for await (const chunk of inputStream) {
            body += String(chunk);
          }
          rl.close();
          input = body.trim();
          const doc = buildResearchDocFromInput({ title, summary, input, template: opts.template });
          const md = ["# " + doc.title, "", doc.summary ? `**Summary:** ${doc.summary}` : "", ""]
            .concat(
              doc.sections.map(
                (s: { title?: string; text: string }) => `## ${s.title ?? ""}\n\n${s.text}`,
              ),
            )
            .join("\n\n");
          if (opts.output) {
            const fs = await import("fs/promises");
            await fs.writeFile(opts.output, md, "utf8");
            defaultRuntime.log(`Wrote ${opts.output}`);
          } else {
            defaultRuntime.log(md);
          }
          if (opts.sectioned) {
            defaultRuntime.log(JSON.stringify(doc, null, 2));
          }
          return;
        }

        if (!input) {
          defaultRuntime.error("No input provided. Use --from-file, --wizard, or --chat.");
          return;
        }

        const doc = buildResearchDocFromInput({
          title: opts.template ?? "Research",
          input,
          template: opts.template,
        });
        const md = ["# " + doc.title, "", doc.summary ? `**Summary:** ${doc.summary}` : "", ""]
          .concat(
            doc.sections.map(
              (s: { title?: string; text: string }) => `## ${s.title ?? ""}\n\n${s.text}`,
            ),
          )
          .join("\n\n");

        if (opts.output) {
          const fs = await import("fs/promises");
          await fs.writeFile(opts.output, md, "utf8");
          if (opts.sectioned) {
            await fs.writeFile(`${opts.output}.json`, JSON.stringify(doc, null, 2), "utf8");
          }
          defaultRuntime.log(`Wrote ${opts.output}`);
        } else {
          defaultRuntime.log(md);
          if (opts.sectioned) {
            defaultRuntime.log(JSON.stringify(doc, null, 2));
          }
        }
      });
    });
}
