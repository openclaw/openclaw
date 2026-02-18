import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { inheritOptionFromParent } from "./command-options.js";

describe("inheritOptionFromParent", () => {
  it("inherits from grandparent when parent does not define the option", async () => {
    const program = new Command().option("--token <token>", "Root token");
    const gateway = program.command("gateway");
    let inherited: string | undefined;

    gateway
      .command("run")
      .option("--token <token>", "Run token")
      .action((_opts, command) => {
        inherited = inheritOptionFromParent<string>(command, "token");
      });

    await program.parseAsync(["--token", "root-token", "gateway", "run"], { from: "user" });
    expect(inherited).toBe("root-token");
  });

  it("prefers nearest ancestor value when multiple ancestors set the same option", async () => {
    const program = new Command().option("--token <token>", "Root token");
    const gateway = program.command("gateway").option("--token <token>", "Gateway token");
    let inherited: string | undefined;

    gateway
      .command("run")
      .option("--token <token>", "Run token")
      .action((_opts, command) => {
        inherited = inheritOptionFromParent<string>(command, "token");
      });

    await program.parseAsync(
      ["--token", "root-token", "gateway", "--token", "gateway-token", "run"],
      { from: "user" },
    );
    expect(inherited).toBe("gateway-token");
  });

  it("does not inherit when the child option was set explicitly", async () => {
    const program = new Command().option("--token <token>", "Root token");
    const gateway = program.command("gateway").option("--token <token>", "Gateway token");
    const run = gateway.command("run").option("--token <token>", "Run token");

    program.setOptionValueWithSource("token", "root-token", "cli");
    gateway.setOptionValueWithSource("token", "gateway-token", "cli");
    run.setOptionValueWithSource("token", "run-token", "cli");

    expect(inheritOptionFromParent<string>(run, "token")).toBeUndefined();
  });

  it("does not inherit from ancestors beyond the bounded traversal depth", async () => {
    const program = new Command().option("--token <token>", "Root token");
    const level1 = program.command("level1");
    const level2 = level1.command("level2");
    let inherited: string | undefined;

    level2
      .command("run")
      .option("--token <token>", "Run token")
      .action((_opts, command) => {
        inherited = inheritOptionFromParent<string>(command, "token");
      });

    await program.parseAsync(["--token", "root-token", "level1", "level2", "run"], {
      from: "user",
    });
    expect(inherited).toBeUndefined();
  });
});
