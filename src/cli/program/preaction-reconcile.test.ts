import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(async () => {}),
  plugins: vi.fn(),
}));
vi.mock("./config-guard.js", () => ({ ensureConfigReady: mocks.config }));
vi.mock("../plugin-registry.js", () => ({ ensurePluginRegistryLoaded: mocks.plugins }));
vi.mock("../banner.js", () => ({ emitCliBanner: vi.fn() }));
vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));
vi.mock("../state-dir-gateway-check.js", () => ({
  checkCliGatewayStateDir: vi.fn(async () => ({ kind: "allow" })),
}));

const originalArgv = process.argv;
const originalTitle = process.title;
afterEach(() => {
  process.argv = originalArgv;
  process.title = originalTitle;
  vi.clearAllMocks();
});

describe("reconciliation global startup", () => {
  it.each(
    ["approvals", "exec-approvals"].flatMap((primary) =>
      [[], ["--keep-current"]].map((flags) => ({ primary, flags })),
    ),
  )("keeps startup passive for $primary $flags", async ({ primary, flags }) => {
    const { registerPreActionHooks } = await import("./preaction.js");
    const program = new Command().name("openclaw");
    const action = vi.fn();
    program
      .command("approvals")
      .alias("exec-approvals")
      .command("reconcile")
      .option("--json")
      .option("--keep-current")
      .action(action);
    registerPreActionHooks(program, "test");
    process.argv = ["node", "openclaw", primary, "reconcile", ...flags, "--json"];
    await program.parseAsync(process.argv);
    expect(action).toHaveBeenCalledOnce();
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.plugins).not.toHaveBeenCalled();
  });
});
