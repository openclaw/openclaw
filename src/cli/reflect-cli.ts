import type { Command } from "commander";
import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";
import {
  appendReflection,
  getReflectionById,
  listReflections,
} from "../reflections/reflection-store.js";
import { formatCliCommand } from "./command-format.js";
import { formatHelpExamples } from "./help-format.js";

async function promptLine(params: {
  rl: readline.Interface;
  label: string;
  optional?: boolean;
  defaultValue?: string;
}): Promise<string> {
  const suffix = params.optional ? " (optional)" : "";
  const defaultHint = params.defaultValue ? ` [default: ${params.defaultValue}]` : "";
  const answer = (await params.rl.question(`${params.label}${suffix}${defaultHint}: `)).trim();
  if (!answer) {
    return params.defaultValue ?? "";
  }
  return answer;
}

function parseTags(input: string): string[] | undefined {
  const raw = input
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return raw.length ? raw : undefined;
}

function formatTags(tags: string[] | undefined): string {
  if (!tags?.length) {
    return "";
  }
  return tags.join(", ");
}

export function registerReflectCli(program: Command, ctx: { programVersion: string }) {
  const reflect = program
    .command("reflect")
    .description("Capture and review short after-action reflections")
    .showHelpAfterError();

  reflect
    .command("add")
    .description("Add a reflection (interactive)")
    .action(async () => {
      const now = new Date();
      const defaultTitle = now.toISOString();

      const rl = readline.createInterface({ input, output });
      try {
        const title = await promptLine({ rl, label: "Title", defaultValue: defaultTitle });
        const context = await promptLine({ rl, label: "Context", optional: true });
        const whatWorked = await promptLine({ rl, label: "What worked", optional: true });
        const whatDidnt = await promptLine({ rl, label: "What didn't", optional: true });
        const nextTime = await promptLine({ rl, label: "Next time", optional: true });
        const tagsRaw = await promptLine({ rl, label: "Tags (comma-separated)", optional: true });

        const entry = await appendReflection({
          input: {
            title,
            context,
            whatWorked,
            whatDidnt,
            nextTime,
            tags: parseTags(tagsRaw),
          },
          openclawVersion: ctx.programVersion,
        });

        // Print the id so user can show it later.
        console.log(entry.id);
      } finally {
        rl.close();
      }
    });

  reflect
    .command("list")
    .description("List reflections (newest first)")
    .option("--limit <n>", "Max items", (v) => parseInt(String(v), 10))
    .option("--tag <tag>", "Filter by tag")
    .action(async (opts: { limit?: number; tag?: string }) => {
      const items = await listReflections({ limit: opts.limit, tag: opts.tag });
      if (items.length === 0) {
        console.log("No reflections yet.");
        return;
      }
      for (const r of items) {
        const tagText = formatTags(r.tags);
        const tagSuffix = tagText ? `  [${tagText}]` : "";
        console.log(`${r.createdAt}  ${r.id}  ${r.title}${tagSuffix}`);
      }
    });

  reflect
    .command("show")
    .description("Show a reflection by id")
    .argument("<id>", "Reflection id")
    .action(async (id: string) => {
      const entry = await getReflectionById(id);
      if (!entry) {
        console.error(`Reflection not found: ${id}`);
        process.exitCode = 1;
        return;
      }

      const tags = formatTags(entry.tags);
      console.log(`${entry.title}`);
      console.log(`id: ${entry.id}`);
      console.log(`createdAt: ${entry.createdAt}`);
      if (tags) {
        console.log(`tags: ${tags}`);
      }
      if (entry.context) {
        console.log(`\nContext\n${entry.context}`);
      }
      if (entry.whatWorked) {
        console.log(`\nWhat worked\n${entry.whatWorked}`);
      }
      if (entry.whatDidnt) {
        console.log(`\nWhat didn't\n${entry.whatDidnt}`);
      }
      if (entry.nextTime) {
        console.log(`\nNext time\n${entry.nextTime}`);
      }
      console.log("\n---\n");
      console.log(JSON.stringify(entry, null, 2));
    });

  reflect.addHelpText(
    "after",
    formatHelpExamples("reflect", [
      {
        heading: "Examples",
        examples: [
          formatCliCommand("reflect add"),
          formatCliCommand("reflect list --limit 20"),
          formatCliCommand("reflect list --tag onboarding"),
          formatCliCommand("reflect show <id>"),
        ],
      },
    ]),
  );
}
