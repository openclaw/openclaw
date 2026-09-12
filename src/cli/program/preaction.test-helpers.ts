import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { expect, it, vi, type MockInstance } from "vitest";

export const COLD_READ_COMMAND_PATHS: string[][] = [
  ["audit"],
  ["node", "identity"],
  ["skills", "info"],
  ["skills", "search"],
  ["hooks"],
  ["hooks", "list"],
  ["hooks", "info"],
  ["hooks", "check"],
  ["update", "--dry-run"],
  ["models", "accounts", "list"],
  ["models", "accounts", "login", "openai"],
  ["models", "accounts", "use", "personal-account"],
  ["models", "accounts", "clear-default", "openai"],
];

export function registerColdReadCommandFixtures(program: Command, skills: Command): void {
  const models = expectDefined(
    program.commands.find((command) => command.name() === "models"),
    "Expected the models fixture",
  );
  const accounts = models.command("accounts");
  for (const command of ["list", "login", "use", "clear-default"]) {
    accounts
      .command(command)
      .argument("[value]")
      .option("--json")
      .action(() => {});
  }
  program
    .command("node")
    .command("identity")
    .option("--json")
    .action(() => {});
  program
    .command("audit")
    .option("--json")
    .action(() => {});
  for (const skillCommand of ["info", "search"]) {
    skills
      .command(skillCommand)
      .argument("[value]")
      .option("--json")
      .action(() => {});
  }
  const hooks = program
    .command("hooks")
    .option("--json")
    .action(() => {});
  hooks
    .command("list")
    .option("--json")
    .action(() => {});
  hooks
    .command("info")
    .argument("[name]")
    .option("--json")
    .action(() => {});
  hooks
    .command("check")
    .option("--json")
    .action(() => {});
  const memory = program.command("memory");
  memory
    .command("status")
    .option("--agent <id>")
    .option("--index")
    .option("--fix")
    .option("--json")
    .action(() => {});
  memory
    .command("search")
    .argument("[query]")
    .option("--agent <id>")
    .option("--json")
    .action(() => {});
}

export function registerNativeExecutorPreActionTests(
  getHooks: () => typeof import("./preaction.js").registerPreActionHooks,
  mocks: { config: MockInstance; plugins: MockInstance; banner: MockInstance },
): void {
  async function runNativeExecutorPreAction(primary: string, action: string, args: string[]) {
    const parser = new Command().name("openclaw");
    const invoke = vi.fn();
    parser
      .command(primary)
      .command(action)
      .option("--update-executor <mode>")
      .option("--token <token>")
      .action(invoke);
    getHooks()(parser, "9.9.9-test");
    process.argv = ["node", "openclaw", primary, action, ...args];
    await parser.parseAsync(process.argv);
    expect(invoke).toHaveBeenCalledOnce();
  }

  it.each(
    ["gateway", "daemon"].flatMap((primary) =>
      ["install", "restart", "stop"].map((action) => [primary, action]),
    ),
  )(
    "keeps the %s %s native capability probe outside stateful bootstrap",
    async (primary, action) => {
      await runNativeExecutorPreAction(primary, action, ["--update-executor", "check"]);

      expect(mocks.config).not.toHaveBeenCalled();
      expect(mocks.plugins).not.toHaveBeenCalled();
      expect(mocks.banner).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "ordinary install", args: [] },
    { label: "native execution", args: ["--update-executor", "run"] },
    { label: "invalid mode", args: ["--update-executor", "invalid"] },
    { label: "check text in another option's value", args: ["--token", "--update-executor=check"] },
  ])("retains config bootstrap for $label", async ({ args }) => {
    await runNativeExecutorPreAction("gateway", "install", args);

    expect(mocks.config).toHaveBeenCalledOnce();
  });
}
