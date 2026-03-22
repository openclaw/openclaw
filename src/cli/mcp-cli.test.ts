import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";

const mockLog = vi.fn();
const mockError = vi.fn();
const mockExit = vi.fn((code: number) => {
  throw new Error(`__exit__:${code}`);
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => mockLog(...args),
    error: (...args: unknown[]) => mockError(...args),
    writeJson: (value: unknown, space = 2) =>
      mockLog(JSON.stringify(value, null, space > 0 ? space : undefined)),
    exit: (code: number) => mockExit(code),
  },
}));

const tempDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-mcp-"));
  tempDirs.push(dir);
  return dir;
}

let registerMcpCli: typeof import("./mcp-cli.js").registerMcpCli;
let sharedProgram: Command;

async function runMcpCommand(args: string[]) {
  await sharedProgram.parseAsync(args, { from: "user" });
}

describe("mcp cli", () => {
  beforeAll(async () => {
    ({ registerMcpCli } = await import("./mcp-cli.js"));
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    registerMcpCli(sharedProgram);
  }, 300_000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("sets and shows a configured MCP server", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await runMcpCommand(["mcp", "set", "context7", '{"command":"uvx","args":["context7-mcp"]}']);
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('Saved MCP server "context7"'));

      mockLog.mockClear();
      await runMcpCommand(["mcp", "show", "context7", "--json"]);
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('"command": "uvx"'));
    });
  });

  it("fails when removing an unknown MCP server", async () => {
    await withTempHome("openclaw-cli-mcp-home-", async () => {
      const workspaceDir = await createWorkspace();
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await expect(runMcpCommand(["mcp", "unset", "missing"])).rejects.toThrow("__exit__:1");
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining('No MCP server named "missing"'),
      );
    });
  });
});
