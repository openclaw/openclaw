import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserParentOpts } from "./browser-cli-shared.js";
import { registerBrowserStateCommands } from "./browser-cli-state.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
  runBrowserResizeWithOutput: vi.fn(async (_params: unknown) => {}),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("./browser-cli-shared.js", () => ({
  callBrowserRequest: mocks.callBrowserRequest,
}));

vi.mock("./browser-cli-resize.js", () => ({
  runBrowserResizeWithOutput: mocks.runBrowserResizeWithOutput,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("browser state option collisions", () => {
  const createBrowserProgram = () => {
    const program = new Command();
    const browser = program
      .command("browser")
      .option("--browser-profile <name>", "Browser profile")
      .option("--json", "Output JSON", false);
    const parentOpts = (cmd: Command) => cmd.parent?.opts?.() as BrowserParentOpts;
    registerBrowserStateCommands(browser, parentOpts);
    return program;
  };

  const getLastRequest = () => {
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call).toBeDefined();
    if (!call) {
      throw new Error("expected browser request call");
    }
    return call[1] as { body?: Record<string, unknown> };
  };

  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.runBrowserResizeWithOutput.mockClear();
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.exit.mockClear();
  });

  it("forwards parent-captured --target-id on `browser cookies set`", async () => {
    const program = createBrowserProgram();

    await program.parseAsync(
      [
        "browser",
        "cookies",
        "set",
        "session",
        "abc",
        "--url",
        "https://example.com",
        "--target-id",
        "tab-1",
      ],
      { from: "user" },
    );

    const request = getLastRequest() as { body?: { targetId?: string } };
    expect(request.body?.targetId).toBe("tab-1");
  });

  it("accepts legacy parent `--json` by parsing payload via positional headers fallback", async () => {
    const program = createBrowserProgram();

    await program.parseAsync(["browser", "set", "headers", "--json", '{"x-auth":"ok"}'], {
      from: "user",
    });

    const request = getLastRequest() as { body?: { headers?: Record<string, string> } };
    expect(request.body?.headers).toEqual({ "x-auth": "ok" });
  });
});
