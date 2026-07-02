// Contract: root `--help` renders descriptions from the placeholder catalogs while
// `<command> --help` and shell completion render the registered command. Both must
// present the same text for every root command (https://github.com/openclaw/openclaw/issues/98978).
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCompletionCli } from "../completion-cli.js";
import {
  getCoreCliCommandDescriptors,
  getCoreCliCommandNames,
  registerCoreCliByName,
} from "./command-registry-core.js";
import { createProgramContext } from "./context.js";
import { getSubCliEntries, registerSubCliByName } from "./register.subclis-core.js";

describe("root command descriptions", () => {
  beforeEach(() => {
    // Pin the private QA gate closed so the registered tree is deterministic
    // regardless of the invoking shell (the qa registrar needs a built dist).
    // beforeEach, not beforeAll: the shared test setup unstubs envs per test.
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps catalog placeholders and registered commands in sync", async () => {
    const program = new Command().name("openclaw");
    const ctx = createProgramContext();
    // Mirror the `openclaw completion` eager registration path: neutral completion
    // argv keeps command-path policies from narrowing or loading plugin commands.
    const argv = ["node", "openclaw", "completion"];

    registerCompletionCli(program);
    for (const name of getCoreCliCommandNames()) {
      await registerCoreCliByName(program, ctx, name, argv);
    }
    for (const entry of getSubCliEntries()) {
      await registerSubCliByName(program, entry.name, argv, { purpose: "completion" });
    }

    const descriptors = [...getCoreCliCommandDescriptors(), ...getSubCliEntries()];
    const commandsByName = new Map(program.commands.map((command) => [command.name(), command]));
    // capability/terminal/chat register as commander aliases of infer/tui. Their
    // catalog rows intentionally describe the alias itself, so they are checked for
    // existence as aliases instead of description equality.
    const aliasNames = new Set(program.commands.flatMap((command) => command.aliases()));

    const missing: string[] = [];
    const mismatches: string[] = [];
    for (const descriptor of descriptors) {
      const command = commandsByName.get(descriptor.name);
      if (!command) {
        if (!aliasNames.has(descriptor.name)) {
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

    expect(missing, "catalog entries with no registered command or alias").toEqual([]);
    expect(mismatches, "root help vs registered command description drift").toEqual([]);
  });
});
