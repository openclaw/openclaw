// Contract: root `--help` renders descriptions from the placeholder catalogs while
// `<command> --help` and shell completion render the registered command. Both must
// present the same text for every root command (https://github.com/openclaw/openclaw/issues/98978).
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  getCoreCliCommandDescriptors,
  getCoreCliCommandNames,
  registerCoreCliByName,
} from "./command-registry-core.js";
import { createProgramContext } from "./context.js";
import { getSubCliEntries, registerSubCliByName } from "./register.subclis-core.js";

// argv-rewrite aliases keep a catalog placeholder for root help but never register a
// real command, so they have no registered description to compare.
const ARGV_ALIAS_ONLY_COMMANDS = new Set(["capability", "terminal", "chat"]);

describe("root command descriptions", () => {
  it("keeps catalog placeholders and registered commands in sync", async () => {
    const program = new Command().name("openclaw");
    const ctx = createProgramContext();
    // Mirror the `openclaw completion` eager registration path: neutral completion
    // argv keeps command-path policies from narrowing or loading plugin commands.
    const argv = ["node", "openclaw", "completion"];

    for (const name of getCoreCliCommandNames()) {
      await registerCoreCliByName(program, ctx, name, argv);
    }
    for (const entry of getSubCliEntries()) {
      // `completion` registers itself outside the sub-CLI group entries.
      if (entry.name === "completion") {
        continue;
      }
      await registerSubCliByName(program, entry.name, argv, { purpose: "completion" });
    }

    const descriptors = [...getCoreCliCommandDescriptors(), ...getSubCliEntries()].filter(
      (descriptor) => descriptor.name !== "completion",
    );
    const commandsByName = new Map(program.commands.map((command) => [command.name(), command]));

    const missing: string[] = [];
    const mismatches: string[] = [];
    for (const descriptor of descriptors) {
      const command = commandsByName.get(descriptor.name);
      if (!command) {
        if (!ARGV_ALIAS_ONLY_COMMANDS.has(descriptor.name)) {
          missing.push(descriptor.name);
        }
        continue;
      }
      if (command.description() !== descriptor.description) {
        mismatches.push(
          `${descriptor.name}\n  catalog:    ${descriptor.description}\n  registered: ${command.description()}`,
        );
      }
    }

    expect(missing, "catalog entries with no registered command").toEqual([]);
    expect(mismatches, "root help vs registered command description drift").toEqual([]);
  });
});
