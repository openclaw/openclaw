import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { ExitError } from "../../runtime.js";
import { registerConfigCli } from "../config-cli.js";
import { registerConfigureCommand } from "./register.configure.js";

const mocks = vi.hoisted(() => ({
  runWizard: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../../commands/configure.wizard.js", () => ({ runConfigureWizard: mocks.runWizard }));
// mock-isolation: test both wizard routes independently of the runner's TTY.
vi.mock("../terminal-interactivity.js", () => ({ isTerminalInteractive: () => true }));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

describe.each(["configure", "config"] as const)("%s dispatch", { concurrent: false }, (route) => {
  async function parse(options: string[] = []) {
    const program = new Command();
    (route === "configure" ? registerConfigureCommand : registerConfigCli)(program);
    return await program.parseAsync([route, ...options], { from: "user" });
  }
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.runWizard.mockResolvedValue(undefined);
    mocks.runtime.exit.mockImplementation((code: number) => {
      throw new ExitError(code);
    });
  });

  it.each([
    [[], {}],
    [[" channels ", "health", "channels"], { sections: ["channels", "health", "channels"] }],
  ] as const)("dispatches omitted or repeated sections: %j", async (sections, options) => {
    await parse(sections.flatMap((section) => ["--section", section]));
    expect(mocks.runWizard).toHaveBeenCalledExactlyOnceWith(options);
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it("waits for the admitted wizard to settle", async () => {
    const entered = createDeferred();
    const released = createDeferred();
    mocks.runWizard.mockImplementationOnce(async () => {
      entered.resolve(undefined);
      await released.promise;
    });
    const settled = vi.fn();
    const parsing = parse(["--section", "channels"]);
    void parsing.catch(entered.reject);
    const observed = parsing.then(settled, settled);
    try {
      await entered.promise;
      expect(settled).not.toHaveBeenCalled();
    } finally {
      released.resolve(undefined);
      await observed;
    }
    await parsing;
  });

  it("preserves its registered failure contract", async () => {
    const failure = new Error("fixture wizard failure");
    mocks.runWizard.mockRejectedValueOnce(failure);
    if (route === "configure") {
      await expect(parse()).rejects.toMatchObject({ code: 1 });
      expect(mocks.runtime.error).toHaveBeenCalledWith("fixture wizard failure");
    } else {
      await expect(parse()).rejects.toBe(failure);
      expect(mocks.runtime.error).not.toHaveBeenCalled();
      expect(mocks.runtime.exit).not.toHaveBeenCalled();
    }
    expect(mocks.runWizard).toHaveBeenCalledOnce();
  });
});
