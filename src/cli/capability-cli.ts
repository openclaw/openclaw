// Capability CLI commands for local/gateway model, media, memory, search, and generation calls.
import type { Command } from "commander";
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { registerAudioCapabilityCommands } from "./capability-cli.audio.js";
import { registerEmbeddingCapabilityCommands } from "./capability-cli.embedding.js";
import { registerImageCapabilityCommands } from "./capability-cli.image.js";
import { registerCapabilityListAndInspect } from "./capability-cli.metadata.js";
import { registerModelCapabilityCommands } from "./capability-cli.model.js";
import { registerTtsCapabilityCommands } from "./capability-cli.tts.js";
import { registerVideoCapabilityCommands } from "./capability-cli.video.js";
import { registerWebCapabilityCommands } from "./capability-cli.web.js";
import { removeCommandByName } from "./program/command-tree.js";

export { CAPABILITY_METADATA } from "./capability-cli.metadata.js";

export function registerCapabilityCli(program: Command) {
  removeCommandByName(program, "infer");
  removeCommandByName(program, "capability");

  const capability = program
    .command("infer")
    .alias("capability")
    .description("Run provider-backed inference commands through a stable CLI surface")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/infer", "docs.openclaw.ai/cli/infer")}\n`,
    );

  registerCapabilityListAndInspect(capability);
  registerModelCapabilityCommands(capability);
  registerImageCapabilityCommands(capability);
  registerAudioCapabilityCommands(capability);
  registerTtsCapabilityCommands(capability);
  registerVideoCapabilityCommands(capability);
  registerWebCapabilityCommands(capability);
  registerEmbeddingCapabilityCommands(capability);
}
