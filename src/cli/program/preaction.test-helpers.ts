import { Command } from "commander";
import { expect, it, vi, type MockInstance } from "vitest";
import { applyParentDefaultHelpAction } from "./parent-default-help.js";

function command(parent: Command, name: string, options: string[] = []): Command {
  const child = parent.command(name).action(() => {});
  for (const option of options) {
    child.option(option);
  }
  return child;
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

  it("keeps the daemon install native capability probe outside stateful bootstrap", async () => {
    await runNativeExecutorPreAction("daemon", "install", ["--update-executor", "check"]);

    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.plugins).not.toHaveBeenCalled();
    expect(mocks.banner).not.toHaveBeenCalled();
  });

  it("retains config bootstrap for ordinary install", async () => {
    await runNativeExecutorPreAction("gateway", "install", []);

    expect(mocks.config).toHaveBeenCalledOnce();
  });
}

export function registerPreActionCommandFixtures(programLocal: Command): void {
  command(programLocal, "agent [note]", ["--agent <id>", "--local", "--json"]).requiredOption(
    "-m, --message <text>",
  );
  command(programLocal, "status", ["--json"]);
  const runOptions = ["--allow-unconfigured", "--force", "--reset"];
  const gateway = command(programLocal, "gateway", [
    "--port <port>",
    "--token <token>",
    ...runOptions,
  ]);
  command(gateway, "run", runOptions);
  for (const name of ["call <method>", "health"]) {
    command(gateway, name, ["--json"]);
  }
  const modelList = programLocal.command("models").command("aliases").command("list");
  modelList.option("--plain").action(() => {});
  const agents = programLocal.command("agents");
  command(agents, "list", ["--json"]);
  command(programLocal, "onboard");
  const channels = programLocal.command("channels");
  command(channels, "add");
  command(channels, "send", ["--json"]);
  applyParentDefaultHelpAction(channels);
  command(programLocal.command("message"), "send", ["--json"]);
}
