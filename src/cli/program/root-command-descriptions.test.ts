// Root help renders catalog placeholders while command help and completion use
// registered Commander commands. Keep those user-facing descriptions aligned.
import "../../test-utils/prepare-compiled-subprocesses.js";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cliCommandCatalog } from "../command-catalog.js";
import { isReservedNonPluginCommandRoot } from "../command-registration-policy.js";
import { collectShellCompletionCommandTree } from "../completion-command-tree.js";
import { registerCoreCliByName } from "./command-registry-core.js";
import { createProgramContext } from "./context.js";
import {
  getCoreCliCommandDescriptors,
  getCoreCliCommandNamesCore,
} from "./core-command-descriptors.js";
import { registerSubCliByName, registerSubCliCommands } from "./register.subclis.js";
import { getSubCliEntriesCore } from "./subcli-descriptors.js";

const RESERVED_CATALOG_ROOTS = ["tool", "tools"];
const PLUGIN_CATALOG_PATHS = commandPaths(
  "browser extension | browser extension native-host | memory | memory search | memory status",
);

function commandPaths(paths: string): string[] {
  return paths.split("|").map((path) => path.trim());
}

async function registerAllBuiltInCommands(): Promise<Command> {
  const program = new Command().name("openclaw");
  const ctx = createProgramContext();
  const argv = ["node", "openclaw", "completion"];

  for (const name of getCoreCliCommandNamesCore()) {
    await registerCoreCliByName(program, ctx, name);
  }
  for (const entry of getSubCliEntriesCore()) {
    await registerSubCliByName(program, entry.name, argv, { purpose: "completion" });
  }
  return program;
}

function collectRegisteredCommandPaths(...programs: Command[]): Set<string> {
  return new Set(
    programs.flatMap((program) =>
      collectShellCompletionCommandTree(program).descendants.flatMap((context) =>
        context.pathVariants.map((path) => path.join(" ")),
      ),
    ),
  );
}

describe("root command descriptions", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps catalog placeholders and registered commands in sync", async () => {
    const program = await registerAllBuiltInCommands();

    const commands = new Map(
      program.commands.flatMap((command) =>
        [command.name(), ...command.aliases()].map((name) => [name, command] as const),
      ),
    );
    expect(commands.has("tasks")).toBe(false);
    for (const descriptor of [...getCoreCliCommandDescriptors(), ...getSubCliEntriesCore()]) {
      const command = commands.get(descriptor.name);
      expect(command, descriptor.name).toBeDefined();
      if (command?.name() === descriptor.name) {
        expect(command.description(), descriptor.name).toBe(descriptor.description);
      }
    }
  });

  it("keeps startup policy catalog paths registered or explicitly reserved", async () => {
    vi.stubEnv("OPENCLAW_EXPERIMENTAL_CLAWS", "");
    const program = await registerAllBuiltInCommands();

    // Private QA is a lazy source-checkout command. Its root placeholder proves
    // registration without importing the private build omitted from normal dist.
    vi.stubEnv("OPENCLAW_ENABLE_PRIVATE_QA_CLI", "1");
    const lazyProgram = new Command().name("openclaw");
    registerSubCliCommands(lazyProgram, ["node", "openclaw", "--help"]);

    const registeredPaths = collectRegisteredCommandPaths(program, lazyProgram);
    const catalogPaths = new Set(cliCommandCatalog.map((entry) => entry.commandPath.join(" ")));
    const reservedPaths = new Set(RESERVED_CATALOG_ROOTS);
    const pluginPaths = new Set(PLUGIN_CATALOG_PATHS);

    // The two exception groups are deliberate: reserved roots and plugin-owned paths.
    for (const path of catalogPaths) {
      expect(
        registeredPaths.has(path) || reservedPaths.has(path) || pluginPaths.has(path),
        path,
      ).toBe(true);
    }
    for (const path of reservedPaths) {
      expect(catalogPaths.has(path) && isReservedNonPluginCommandRoot(path), path).toBe(true);
      expect(registeredPaths.has(path), path).toBe(false);
    }
    for (const path of pluginPaths) {
      expect(catalogPaths.has(path), path).toBe(true);
      expect(registeredPaths.has(path), path).toBe(false);
    }
  });
});
