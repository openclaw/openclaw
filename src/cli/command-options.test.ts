// Command option tests cover shared CLI option registration and parsing.
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { hasExplicitOptions, inheritOptionFromParent } from "./command-options.js";

function attachRunCommandAndCaptureInheritedToken(command: Command) {
  let inherited: string | undefined;
  command
    .command("run")
    .option("--token <token>", "Run token")
    .action((_opts, childCommand) => {
      inherited = inheritOptionFromParent<string>(childCommand, "token");
    });
  return () => inherited;
}

describe("hasExplicitOptions", () => {
  it.each([{ source: "env", expected: false }] as const)(
    "recognizes only cli option sources ($source)",
    ({ source, expected }) => {
      const command = new Command().option("--token <token>", "Token");
      command.setOptionValueWithSource("token", "test-token", source);

      expect(hasExplicitOptions(command, ["token"])).toBe(expected);
    },
  );
});

describe("inheritOptionFromParent", () => {
  it("does not override an explicitly negated child value", async () => {
    const program = new Command();
    const gateway = program.command("gateway").option("--force", "Force");
    const run = gateway
      .command("run")
      .option("--no-force", "Disable force")
      .action(() => {});

    await program.parseAsync(["gateway", "--force", "run", "--no-force"], {
      from: "user",
    });

    expect(run.getOptionValue("force")).toBe(false);
    expect(inheritOptionFromParent<boolean>(run, "force")).toBeUndefined();
  });

  it("does not inherit from ancestors beyond the bounded traversal depth", async () => {
    const program = new Command().option("--token <token>", "Root token");
    const level1 = program.command("level1");
    const level2 = level1.command("level2");
    const getInherited = attachRunCommandAndCaptureInheritedToken(level2);

    await program.parseAsync(["--token", "root-token", "level1", "level2", "run"], {
      from: "user",
    });
    expect(getInherited()).toBeUndefined();
  });

  it("can restrict inherited values to an explicit CLI source", () => {
    const gateway = new Command().option("--token <token>", "Gateway token");
    const run = gateway.command("run").option("--token <token>", "Run token");

    gateway.setOptionValueWithSource("token", "gateway-env-token", "env");
    expect(inheritOptionFromParent<string>(run, "token", "cli")).toBeUndefined();

    gateway.setOptionValueWithSource("token", "gateway-cli-token", "cli");
    expect(inheritOptionFromParent<string>(run, "token", "cli")).toBe("gateway-cli-token");
  });

  it("returns undefined when command is missing", () => {
    expect(inheritOptionFromParent<string>(undefined, "token")).toBeUndefined();
  });
});
