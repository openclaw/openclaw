// Argv invocation tests cover CLI argv normalization before command dispatch.
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { resolveCliArgvInvocation } from "./argv-invocation.js";
import { getCommanderCommandPath } from "./program/commander-parse-facts.js";

describe("argv-invocation", () => {
  it("resolves root help and empty command path", () => {
    expect(resolveCliArgvInvocation(["node", "openclaw", "--help"])).toEqual({
      argv: ["node", "openclaw", "--help"],
      commandPath: [],
      primary: null,
      hasHelpOrVersion: true,
      isRootHelpInvocation: true,
    });
  });

  it("resolves command path and primary with root options", () => {
    expect(
      resolveCliArgvInvocation(["node", "openclaw", "--profile", "work", "gateway", "status"]),
    ).toEqual({
      argv: ["node", "openclaw", "--profile", "work", "gateway", "status"],
      commandPath: ["gateway", "status"],
      primary: "gateway",
      hasHelpOrVersion: false,
      isRootHelpInvocation: false,
    });
  });

  it.each([
    ["skills", ["--agent", "verify"], ["skills"]],

    ["skills", ["--", "verify"], ["skills", "verify"]],
  ])("matches Commander for %s %j", async (rootName, args, expectedPath) => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    const root = program.command(rootName);
    if (rootName === "config") {
      root.option("--section <section>");
    } else {
      root.option("--agent <id>").option("--json");
    }
    const child = root.command(rootName === "config" ? "get" : "verify");
    let parsedPath: string[] = [];
    for (const command of [root, child]) {
      command.action(() => {
        parsedPath = getCommanderCommandPath(command);
      });
    }
    const argv = ["node", "openclaw", rootName, ...args];

    await program.parseAsync(argv);

    expect(parsedPath).toEqual(expectedPath);
    expect(resolveCliArgvInvocation(argv).commandPath).toEqual(parsedPath);
  });

  it.each([["help", "update", "cleanup"]])(
    "recognizes update help without promoting scoped version flags: %j",
    (...args) => {
      expect(resolveCliArgvInvocation(["node", "openclaw", ...args]).hasHelpOrVersion).toBe(true);
    },
  );
});
