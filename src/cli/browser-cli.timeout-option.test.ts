import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserActionInputCommands } from "./browser-cli-actions-input.js";
import { registerBrowserInspectCommands } from "./browser-cli-inspect.js";
import { createBrowserProgram } from "./browser-cli-test-helpers.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(
    async (_opts: unknown, req: { path?: string }, _extra?: { timeoutMs?: number }) => {
      if (req.path === "/snapshot") {
        return {
          ok: true,
          format: "ai",
          targetId: "t1",
          url: "https://example.com",
          snapshot: "ok",
        };
      }
      return {
        ok: true,
        targetId: "t1",
        url: "https://example.com",
      };
    },
  ),
  loadConfig: vi.fn(() => ({ browser: {} })),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("./browser-cli-shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./browser-cli-shared.js")>();
  return {
    ...actual,
    callBrowserRequest: mocks.callBrowserRequest,
  };
});

vi.mock("../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("browser CLI timeout forwarding", () => {
  function createProgram() {
    const { program, browser, parentOpts } = createBrowserProgram();
    browser.option("--timeout <ms>", "Timeout in ms", "30000");
    registerBrowserActionInputCommands(browser, parentOpts);
    registerBrowserInspectCommands(browser, parentOpts);
    return program;
  }

  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.loadConfig.mockClear();
    mocks.loadConfig.mockReturnValue({ browser: {} });
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.exit.mockClear();
  });

  it("uses parent --timeout for click", async () => {
    const program = createProgram();
    await program.parseAsync(["browser", "--timeout", "1234", "click", "e1"], { from: "user" });

    const clickCall = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(clickCall?.[2]).toEqual({ timeoutMs: 1234 });
  });

  it("uses parent --timeout for snapshot", async () => {
    const program = createProgram();
    await program.parseAsync(["browser", "--timeout", "2345", "snapshot"], { from: "user" });

    const snapshotCall = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(snapshotCall?.[2]).toEqual({ timeoutMs: 2345 });
  });

  it("prefers command-specific timeout over the parent timeout", async () => {
    const program = createProgram();
    await program.parseAsync(
      ["browser", "--timeout", "2345", "scrollintoview", "e1", "--timeout-ms", "456"],
      { from: "user" },
    );

    const scrollCall = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(scrollCall?.[2]).toEqual({ timeoutMs: 456 });
    expect(
      (scrollCall?.[1] as { body?: { timeoutMs?: number } } | undefined)?.body?.timeoutMs,
    ).toBe(456);
  });
});
