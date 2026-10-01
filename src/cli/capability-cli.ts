import type { Command } from "commander";
import { FLAG_TERMINATOR, getCommandArgsWithRootOptions } from "../infra/cli-root-options.js";
import { getCommandPathWithRootOptions, normalizeRootLogLevelArgv } from "./argv.js";
import { CAPABILITY_METADATA } from "./capability-cli/metadata.js";
import { providerSummaryText } from "./capability-cli/output.js";
import { runCapabilityCommand } from "./capability-cli/providers-command.js";
import { formatDocsHelp } from "./help-format.js";
import { removeCommandByName } from "./program/command-tree.js";

const capabilityCommandGroups = [
  [
    "model",
    async () => (await import("./capability-cli/model.js")).registerModelCapabilityCommands,
  ],
  [
    "image",
    async () => (await import("./capability-cli/image.js")).registerImageCapabilityCommands,
  ],
  [
    "audio",
    async () => (await import("./capability-cli/audio.js")).registerAudioCapabilityCommands,
  ],
  ["tts", async () => (await import("./capability-cli/tts.js")).registerTtsCapabilityCommands],
  [
    "video",
    async () => (await import("./capability-cli/video.js")).registerVideoCapabilityCommands,
  ],
  ["web", async () => (await import("./capability-cli/web.js")).registerWebCapabilityCommands],
  [
    "embedding",
    async () => (await import("./capability-cli/embedding.js")).registerEmbeddingCapabilityCommands,
  ],
] as const;

function registerCapabilityListAndInspect(capability: Command): void {
  capability
    .command("list")
    .description("List canonical capability ids and supported transports")
    .option("--json", "Output JSON", false)
    .action((opts) =>
      runCapabilityCommand(opts.json, providerSummaryText, () =>
        CAPABILITY_METADATA.map((entry) => ({
          id: entry.id,
          transports: entry.transports,
          description: entry.description,
        })),
      ),
    );

  capability
    .command("inspect")
    .description("Inspect one canonical capability id")
    .requiredOption("--name <capability>", "Capability id")
    .option("--json", "Output JSON", false)
    .action((opts) =>
      runCapabilityCommand(opts.json, undefined, () => {
        const id = String(opts.name);
        const entry = CAPABILITY_METADATA.find((candidate) => candidate.id === id);
        if (!entry) {
          throw new Error(`Unknown capability: ${String(opts.name)}`);
        }
        return entry;
      }),
    );
}

async function registerCapabilityDomainCommands(
  capability: Command,
  argv: string[],
): Promise<void> {
  // Root log levels are normalized after registration. Reuse that view for selection,
  // leaving help and unknown options ahead of a domain on the complete-tree path.
  const selectionArgv = normalizeRootLogLevelArgv(argv);
  const commandPath = getCommandPathWithRootOptions(selectionArgv, 2);
  const primary = commandPath[0];
  const commandArgs =
    primary === "infer" || primary === "capability"
      ? getCommandArgsWithRootOptions(selectionArgv, {
          commandPath: [primary],
          mode: "command-path",
        })
      : undefined;
  // The raw tail marks both leading and post-parent `--`; only the former retains a domain.
  const selectedName = commandArgs?.[0] === FLAG_TERMINATOR ? commandPath[1] : commandArgs?.[0];
  if (selectedName === "list" || selectedName === "inspect") {
    return;
  }
  const selected = capabilityCommandGroups.find(([name]) => name === selectedName);
  if (selected) {
    const register = await selected[1]();
    register(capability);
    return;
  }

  const registrars = await Promise.all(capabilityCommandGroups.map(([, load]) => load()));
  for (const register of registrars) {
    register(capability);
  }
}

export async function registerCapabilityCli(
  program: Command,
  argv: string[] = process.argv,
): Promise<void> {
  removeCommandByName(program, "infer");
  removeCommandByName(program, "capability");

  const capability = program
    .command("infer")
    .alias("capability")
    .description("Run provider-backed inference commands through a stable CLI surface")
    .addHelpText("after", () => formatDocsHelp("/cli/infer"));

  registerCapabilityListAndInspect(capability);
  await registerCapabilityDomainCommands(capability, argv);
}
