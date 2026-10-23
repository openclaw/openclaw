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

const RESERVED_CATALOG_ROOTS = {
  tool: "reserved so plugin registration cannot claim this unregistered root",
  tools: "reserved so plugin registration cannot claim this unregistered root",
} as const;

const PLUGIN_CATALOG_PATHS = {
  "browser extension": "registered and covered by the browser plugin",
  "browser extension native-host": "registered and covered by the browser plugin",
  memory: "registered and covered by the memory-core plugin",
  "memory search": "registered and covered by the memory-core plugin",
  "memory status": "registered and covered by the memory-core plugin",
} as const;

function commandPaths(paths: string): string[] {
  return paths.split("|").map((path) => path.trim());
}

const JSON_NOT_APPLICABLE = {
  // command group only; reporting subcommands declare JSON output individually.
  namespaces: commandPaths(`
      agents team | claws | backup | backup git | backup sqlite | database | database ownership |
      message | message thread | message emoji | message sticker | message role | message channel |
      message member | message voice | message event | mcp | transcripts |
      gateway restart-handoff | gateway diagnostics | system | system heartbeat | promos | telemetry |
      infer | infer model | infer model auth | infer image | infer audio | infer tts | infer video |
      infer web | infer embedding | approvals | approvals allowlist | approvals grants | exec-policy |
      nodes | nodes camera | nodes screen | nodes location | devices | users | node | sandbox |
      worktrees | cron | dns | proxy | webhooks | webhooks gmail | clawbot | pairing |
      plugins | plugins marketplace | channels | channels dead-letters |
      directory | directory peers | directory groups | security | secrets | secrets store |
      models aliases | models fallbacks | models image-fallbacks | models auth | models auth order |
      skills workshop
  `),
  // interactive wizard, login, or terminal session has no single report document.
  interactive: commandPaths(`
      configure | config | acp client | gateway auth-token | promos claim | infer model auth login |
      models auth add | models auth login | models auth setup-token | models auth paste-token |
      models auth paste-api-key | models auth login-github-copilot |
      mcp configure | mcp login | attach | tui | resume | update wizard
  `),
  // long-running server, worker, or live stream does not terminate with one JSON document.
  longRunning: commandPaths(`
      acp | gateway | gateway run | mcp serve | node worker | node run | connect | worker |
      proxy start | proxy run | webhooks gmail run | hooks relay | sessions tail
  `),
  // pure side-effect command has no meaningful report payload.
  mutations: commandPaths(`
      reset | uninstall | backup enable | backup disable | telemetry on | telemetry off | config set |
      mcp add | mcp set | mcp tools | mcp logout | mcp reload | mcp unset |
      onboard recommendations acknowledge | onboard recommendations refresh |
      models set | models set-image | models aliases add | models aliases remove |
      models fallbacks add | models fallbacks remove | models fallbacks clear |
      models image-fallbacks add | models image-fallbacks remove | models image-fallbacks clear |
      models auth activate | models auth logout | models auth order set | models auth order clear |
      hooks enable | hooks disable | hooks install | hooks update | skills install | skills update |
      sandbox recreate | dns setup | proxy purge | pairing approve |
      plugins enable | plugins disable | plugins uninstall | plugins install | plugins update |
      plugins build | plugins init | channels add | channels remove | channels login | channels logout |
      secrets store set | secrets store rm | secrets store import
  `),
  // Raw artifacts already have a machine-readable byte contract.
  rawArtifacts: ["proxy blob"],
  // Completion output must remain executable shell source.
  shellIntegration: ["completion"],
} as const;

// These commands own JSON output without an optional --json flag.
const JSON_OUTPUT_WITHOUT_FLAG = new Set([
  "agents",
  "update admit",
  "update migrate",
  "update restore",
  "update finish",
]);

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

function hasOwnJsonOption(command: Command): boolean {
  return command.options.some((option) => option.long === "--json");
}

function supportsJsonOutput(path: string, command: Command): boolean {
  // `config set --json` is a legacy strict-input parser alias. Only its
  // `--dry-run --json` combination reports JSON, so the mutation stays N/A.
  if (path === "config set") {
    return false;
  }
  return hasOwnJsonOption(command) || JSON_OUTPUT_WITHOUT_FLAG.has(path);
}

function requiredCommandArgs(command: Command): string[] {
  const args = command.registeredArguments.flatMap((argument) => {
    if (!argument.required) {
      return [];
    }
    return ["guard-value"];
  });
  for (const option of command.options) {
    if (!option.mandatory) {
      continue;
    }
    const flag = option.long ?? option.short;
    if (!flag) {
      continue;
    }
    args.push(flag);
    if (option.required || option.optional) {
      args.push(option.argChoices?.[0] ?? "guard-value");
    }
  }
  return args;
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
    const reservedPaths = new Set(Object.keys(RESERVED_CATALOG_ROOTS));
    const pluginPaths = new Set(Object.keys(PLUGIN_CATALOG_PATHS));

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

  it("classifies every built-in command as JSON output or explicitly not applicable", async () => {
    const program = await registerAllBuiltInCommands();
    const contexts = collectShellCompletionCommandTree(program).descendants;
    const registered = new Map(
      contexts.map((context) => [context.pathVariants[0]?.join(" ") ?? "", context.command]),
    );
    const notApplicableEntries = Object.values(JSON_NOT_APPLICABLE).flat();
    const notApplicable = new Set<string>(notApplicableEntries);
    expect(notApplicable.size, "duplicate JSON N/A entries").toBe(notApplicableEntries.length);

    for (const [path, command] of registered) {
      expect(supportsJsonOutput(path, command) || notApplicable.has(path), path).toBe(true);
    }
    for (const path of notApplicable.keys()) {
      const command = registered.get(path);
      expect(command, path).toBeDefined();
      expect(command && supportsJsonOutput(path, command), path).toBe(false);
    }
    for (const path of JSON_OUTPUT_WITHOUT_FLAG) {
      const command = registered.get(path);
      expect(command, path).toBeDefined();
      expect(command && hasOwnJsonOption(command), path).toBe(false);
    }
  });

  it("accepts declared JSON output options through the registered command parsers", async () => {
    const program = await registerAllBuiltInCommands();
    const contexts = collectShellCompletionCommandTree(program).descendants.filter((context) => {
      const path = context.pathVariants[0]?.join(" ") ?? "";
      return supportsJsonOutput(path, context.command) && hasOwnJsonOption(context.command);
    });

    expect(contexts.length).toBeGreaterThan(0);
    for (const context of contexts) {
      const path = context.pathVariants[0]?.join(" ") ?? "";
      const failure = new Error(`synthetic failure for ${path}`);
      context.command.action(async () => {
        throw failure;
      });
      const args = [
        ...requiredCommandArgs(context.command),
        // Conditional alternatives are not represented by Commander's mandatory options.
        ...(path === "database port" ? ["--to", "sqlite"] : []),
        "--json",
      ];

      await expect(context.command.parseAsync(args, { from: "user" }), path).rejects.toBe(failure);
    }
  });
});
