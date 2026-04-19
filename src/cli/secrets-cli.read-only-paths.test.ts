import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSecretsCli } from "./secrets-cli.js";
import { READ_ONLY_AUTH_COMMAND_PATHS } from "./secrets-cli.read-only-paths.js";

function findSubcommand(root: Command, path: readonly string[]): Command | undefined {
  let current: Command | undefined = root;
  for (const name of path) {
    if (current === undefined) {
      return undefined;
    }
    current = current.commands.find((cmd) => cmd.name() === name);
  }
  return current;
}

describe("READ_ONLY_AUTH_COMMAND_PATHS manifest", () => {
  it("is non-empty (a silently emptied manifest would pass this suite otherwise)", () => {
    expect(READ_ONLY_AUTH_COMMAND_PATHS.length).toBeGreaterThan(0);
  });

  it("declares every path as a non-empty token list", () => {
    for (const path of READ_ONLY_AUTH_COMMAND_PATHS) {
      expect(path.length).toBeGreaterThan(0);
      for (const token of path) {
        expect(token).toMatch(/^[^-]/);
        expect(token).not.toBe("");
      }
    }
  });

  it("has every entry resolving to a real registered Commander subcommand path", () => {
    const program = new Command();
    registerSecretsCli(program);

    for (const path of READ_ONLY_AUTH_COMMAND_PATHS) {
      const resolved = findSubcommand(program, path);
      if (resolved === undefined) {
        throw new Error(
          `Manifest entry ${JSON.stringify(path)} has no matching Commander subcommand — likely a rename at src/cli/secrets-cli.ts. Update READ_ONLY_AUTH_COMMAND_PATHS in src/cli/secrets-cli.read-only-paths.ts.`,
        );
      }
      expect(resolved.name()).toBe(path[path.length - 1]);
    }
  });
});
