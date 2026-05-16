import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn(),
  hasBinary: vi.fn(),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../agents/skills.js", () => ({
  hasBinary: mocks.hasBinary,
}));

vi.mock("../terminal/theme.js", () => ({
  isRich: () => false,
  theme: {
    heading: (value: string) => value,
    info: (value: string) => value,
    muted: (value: string) => value,
    command: (value: string) => value,
  },
}));

import { docsSearchCommand } from "./docs.js";

function createRuntime() {
  const logs: string[] = [];
  const errors: string[] = [];
  let exitCode: number | undefined;
  const runtime: RuntimeEnv = {
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    },
    error: (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    },
    exit: (code: number) => {
      exitCode = code;
    },
  };
  return {
    runtime,
    logs,
    errors,
    get exitCode() {
      return exitCode;
    },
  };
}

describe("docsSearchCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasBinary.mockImplementation((name: string) => name === "mcporter");
  });

  it("calls the search_open_claw MCP tool via mcporter", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout:
        "Title: Browser\nLink: https://docs.openclaw.ai/tools/browser\nContent: Existing session via Chrome DevTools MCP.",
      stderr: "",
    });

    const { runtime, logs, exitCode } = createRuntime();
    await docsSearchCommand(["browser", "existing-session"], runtime);

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(
      [
        "mcporter",
        "call",
        "https://docs.openclaw.ai/mcp.search_open_claw",
        "--args",
        JSON.stringify({ query: "browser existing-session" }),
        "--output",
        "text",
      ],
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("Browser");
  });

  it("fails when mcporter returns an MCP tool error with exit code 0", async () => {
    mocks.runCommandWithTimeout.mockResolvedValue({
      code: 0,
      stdout: "MCP error -32602: Tool SearchOpenClaw not found",
      stderr: "",
    });

    const { runtime, logs, errors, exitCode } = createRuntime();
    await docsSearchCommand(["plugin", "allowlist"], runtime);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Docs search failed:");
    expect(errors.join("\n")).toContain("Tool SearchOpenClaw not found");
    expect(logs.join("\n")).not.toContain("No results");
  });
});
