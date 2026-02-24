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
  const createBrowserProgram = ({ withGatewayUrl = false } = {}) => {
    const program = new Command();
    const browser = program
      .command("browser")
      .option("--browser-profile <name>", "Browser profile")
      .option("--json", "Output JSON", false);
    if (withGatewayUrl) {
      browser.option("--url <url>", "Gateway WebSocket URL");
    }
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

  const runBrowserCommand = async (argv: string[]) => {
    const program = createBrowserProgram();
    await program.parseAsync(["browser", ...argv], { from: "user" });
  };

  const runBrowserCommandAndGetRequest = async (argv: string[]) => {
    await runBrowserCommand(argv);
    return getLastRequest();
  };

  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.runBrowserResizeWithOutput.mockClear();
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.exit.mockClear();
  });

  it("forwards parent-captured --target-id on `browser cookies set`", async () => {
    const request = await runBrowserCommandAndGetRequest([
      "cookies",
      "set",
      "session",
      "abc",
      "--url",
      "https://example.com",
      "--target-id",
      "tab-1",
    ]);

    expect((request as { body?: { targetId?: string } }).body?.targetId).toBe("tab-1");
  });

  it("resolves --url via parent when addGatewayClientOptions captures it", async () => {
    const program = createBrowserProgram({ withGatewayUrl: true });
    await program.parseAsync(
      ["browser", "--url", "ws://gw", "cookies", "set", "session", "abc", "--url", "https://example.com"],
      { from: "user" },
    );
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call).toBeDefined();
    const request = call![1] as { body?: { cookie?: { url?: string } } };
    expect(request.body?.cookie?.url).toBe("https://example.com");
  });

  it("inherits --url from parent when subcommand does not provide it", async () => {
    const program = createBrowserProgram({ withGatewayUrl: true });
    await program.parseAsync(
      ["browser", "--url", "https://inherited.example.com", "cookies", "set", "session", "abc"],
      { from: "user" },
    );
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call).toBeDefined();
    const request = call![1] as { body?: { cookie?: { url?: string } } };
    expect(request.body?.cookie?.url).toBe("https://inherited.example.com");
  });

  it("accepts legacy parent `--json` by parsing payload via positional headers fallback", async () => {
    const request = (await runBrowserCommandAndGetRequest([
      "set",
      "headers",
      "--json",
      '{"x-auth":"ok"}',
    ])) as {
      body?: { headers?: Record<string, string> };
    };
    expect(request.body?.headers).toEqual({ "x-auth": "ok" });
  });

  it("filters non-string header values from JSON payload", async () => {
    const request = (await runBrowserCommandAndGetRequest([
      "set",
      "headers",
      "--json",
      '{"x-auth":"ok","retry":3,"enabled":true}',
    ])) as {
      body?: { headers?: Record<string, string> };
    };
    expect(request.body?.headers).toEqual({ "x-auth": "ok" });
  });

  it("errors when set offline receives an invalid value", async () => {
    await runBrowserCommand(["set", "offline", "maybe"]);

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining("Expected on|off"));
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("errors when set media receives an invalid value", async () => {
    await runBrowserCommand(["set", "media", "sepia"]);

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Expected dark|light|none"),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("errors when headers JSON is missing", async () => {
    await runBrowserCommand(["set", "headers"]);

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Missing headers JSON"),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("errors when headers JSON is not an object", async () => {
    await runBrowserCommand(["set", "headers", "--json", "[]"]);

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Headers JSON must be a JSON object"),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });
});
