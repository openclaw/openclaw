import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { configureCommandFromSectionsArg } from "../../commands/configure.commands.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { registerConfigCli } from "../config-cli.js";
import { registerConfigureCommand } from "./register.configure.js";

const mocks = vi.hoisted(() => ({
  interactive: vi.fn(),
  runWizard: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

vi.mock("../../commands/configure.wizard.js", () => ({ runConfigureWizard: mocks.runWizard }));
vi.mock("../terminal-interactivity.js", () => ({ isTerminalInteractive: mocks.interactive }));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

const routes = ["configure", "config"] as const;
type Route = (typeof routes)[number];

async function parse(route: Route, options: string[] = []) {
  const program = new Command();
  if (route === "configure") {
    registerConfigureCommand(program);
  } else {
    registerConfigCli(program);
  }
  return await program.parseAsync([route, ...options], { from: "user" });
}

describe("registered configure dispatch", { concurrent: false }, () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.interactive.mockReturnValue(true);
    mocks.runWizard.mockResolvedValue(undefined);
    mocks.runtime.exit.mockImplementation((code: number) => {
      throw new ExitError(code);
    });
  });

  it.each(routes)("%s omits sections for the full chooser", async (route) => {
    await parse(route);
    expect(mocks.runWizard).toHaveBeenCalledExactlyOnceWith(
      { command: "configure" },
      defaultRuntime,
    );
    expect(mocks.runWizard.mock.calls[0]?.[1]).toBe(defaultRuntime);
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it.each(routes)("%s preserves repeated, trimmed section values", async (route) => {
    await parse(route, ["--section", " channels ", "--section", "health", "--section", "channels"]);
    expect(mocks.runWizard).toHaveBeenCalledExactlyOnceWith(
      { command: "configure", sections: ["channels", "health", "channels"] },
      defaultRuntime,
    );
    expect(mocks.runWizard.mock.calls[0]?.[1]).toBe(defaultRuntime);
  });

  it.each(routes)("%s rejects a blank section before testing the terminal", async (route) => {
    mocks.interactive.mockReturnValue(false);
    await expect(parse(route, ["--section", " "])).rejects.toMatchObject({ code: 1 });
    expect(mocks.runtime.error).toHaveBeenCalledOnce();
    expect(mocks.runtime.error.mock.calls[0]?.[0]).toContain('Invalid --section: "".');
    expect(mocks.interactive).not.toHaveBeenCalled();
    expect(mocks.runWizard).not.toHaveBeenCalled();
  });

  it.each(routes)("%s rejects an unknown section without widening scope", async (route) => {
    await expect(parse(route, ["--section", "not-a-section"])).rejects.toMatchObject({ code: 1 });
    expect(mocks.runtime.error.mock.calls[0]?.[0]).toContain("Invalid --section: not-a-section.");
    expect(mocks.runWizard).not.toHaveBeenCalled();
  });

  it.each(routes)("%s refuses a non-interactive terminal", async (route) => {
    mocks.interactive.mockReturnValue(false);
    await expect(parse(route, ["--section", "channels"])).rejects.toMatchObject({ code: 1 });
    expect(mocks.runtime.error).toHaveBeenCalledOnce();
    expect(mocks.runtime.error.mock.calls[0]?.[0]).toContain(
      "requires an interactive terminal (TTY)",
    );
    expect(mocks.runWizard).not.toHaveBeenCalled();
  });

  it.each(routes)("%s waits for the admitted wizard to settle", async (route) => {
    const entered = createDeferred();
    const released = createDeferred();
    mocks.runWizard.mockImplementationOnce(async () => {
      entered.resolve(undefined);
      await released.promise;
    });
    let settled = false;
    const parsing = parse(route, ["--section", "channels"]);
    void parsing.catch(entered.reject);
    const observed = parsing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await entered.promise;
      expect(settled).toBe(false);
    } finally {
      released.resolve(undefined);
      await observed;
    }
    await parsing;
    expect(settled).toBe(true);
    expect(mocks.runWizard).toHaveBeenCalledOnce();
  });

  it.each(routes)("%s preserves its registered failure contract", async (route) => {
    const failure = new Error("fixture wizard failure");
    mocks.runWizard.mockRejectedValueOnce(failure);
    if (route === "configure") {
      await expect(parse(route)).rejects.toMatchObject({ code: 1 });
      expect(mocks.runtime.error).toHaveBeenCalledWith("fixture wizard failure");
    } else {
      await expect(parse(route)).rejects.toBe(failure);
      expect(mocks.runtime.error).not.toHaveBeenCalled();
      expect(mocks.runtime.exit).not.toHaveBeenCalled();
    }
    expect(mocks.runWizard).toHaveBeenCalledOnce();
  });

  it("passes a caller-provided runtime by identity", async () => {
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    await configureCommandFromSectionsArg(["channels"], runtime, { interactive: true });
    expect(mocks.runWizard).toHaveBeenCalledExactlyOnceWith(
      { command: "configure", sections: ["channels"] },
      runtime,
    );
    expect(mocks.runWizard.mock.calls[0]?.[1]).toBe(runtime);
  });
});
