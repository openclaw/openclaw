import fs from "node:fs/promises";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { Mem0Client } from "../../memory/mem0-client.js";
import * as agentScope from "../agent-scope.js";
import { createMemoryAddTool } from "./memory-tool.js";

vi.mock("../../memory/mem0-client.js");
vi.mock("node:fs/promises");
vi.mock("../../config/types.secrets.js", () => ({
  normalizeResolvedSecretInputString: () => "mock-api-key",
}));

function makeCfg(mem0Enabled: boolean): OpenClawConfig {
  return {
    memory: { mem0: { enabled: mem0Enabled, apiKey: "secret" } },
  } as unknown as OpenClawConfig;
}

describe("memory_add Dual-Write Logic", () => {
  beforeEach(() => {
    vi.spyOn(agentScope, "resolveAgentWorkspaceDir").mockReturnValue("/mock/workspace");
    vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);
    vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
  });

  it("writes to both local Markdown and Mem0 asynchronously when enabled", async () => {
    const mem0AddMemory = vi.fn().mockResolvedValue(undefined);
    // function keyword required so vitest can use it as a constructor
    vi.mocked(Mem0Client).mockImplementation(function (this: Mem0Client) {
      (this as unknown as { addMemory: typeof mem0AddMemory }).addMemory = mem0AddMemory;
      (this as unknown as { searchMemories: ReturnType<typeof vi.fn> }).searchMemories = vi.fn();
    } as unknown as typeof Mem0Client);

    const tool = createMemoryAddTool({ config: makeCfg(true), agentSessionKey: "test_session" });
    const result = await tool!.execute("call_1", { content: "My favorite color is blue." });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed).toMatchObject({ success: true, federated: true });

    // Verify Local Write
    expect(fs.mkdir).toHaveBeenCalledWith("/mock/workspace/memory", { recursive: true });
    expect(fs.appendFile).toHaveBeenCalledWith(
      expect.stringContaining("/mock/workspace/memory/"),
      expect.stringContaining("My favorite color is blue."),
      "utf-8",
    );

    // Verify Mem0 fire-and-forget was triggered
    expect(mem0AddMemory).toHaveBeenCalled();
  });

  it("only writes local Markdown if Mem0 is disabled", async () => {
    const mem0AddMemory = vi.fn();
    vi.mocked(Mem0Client).mockImplementation(function (this: Mem0Client) {
      (this as unknown as { addMemory: typeof mem0AddMemory }).addMemory = mem0AddMemory;
      (this as unknown as { searchMemories: ReturnType<typeof vi.fn> }).searchMemories = vi.fn();
    } as unknown as typeof Mem0Client);

    const cfg = makeCfg(false);
    const tool = createMemoryAddTool({ config: cfg, agentSessionKey: "test_session" });
    const result = await tool!.execute("call_2", { content: "Something strictly local." });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed).toMatchObject({ federated: false });
    expect(fs.appendFile).toHaveBeenCalled();
    expect(mem0AddMemory).not.toHaveBeenCalled();
  });
});
