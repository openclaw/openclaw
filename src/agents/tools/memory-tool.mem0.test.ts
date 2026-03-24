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

/** Helper to set up a Mem0Client mock and spy on fs. */
function setupMocks(addMemoryImpl: () => Promise<void> = () => Promise.resolve()) {
  const mem0AddMemory = vi.fn().mockImplementation(addMemoryImpl);
  vi.mocked(Mem0Client).mockImplementation(function (this: Mem0Client) {
    (this as unknown as { addMemory: typeof mem0AddMemory }).addMemory = mem0AddMemory;
    (this as unknown as { searchMemories: ReturnType<typeof vi.fn> }).searchMemories = vi.fn();
  } as unknown as typeof Mem0Client);
  vi.spyOn(fs, "appendFile").mockResolvedValue(undefined);
  vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
  return { mem0AddMemory };
}

describe("memory_add Dual-Write Logic", () => {
  beforeEach(() => {
    vi.spyOn(agentScope, "resolveAgentWorkspaceDir").mockReturnValue("/mock/workspace");
  });

  // ─── Happy path ──────────────────────────────────────────────────────────────

  it("writes to both local Markdown and Mem0 when enabled", async () => {
    const { mem0AddMemory } = setupMocks();

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
    const { mem0AddMemory } = setupMocks();

    const tool = createMemoryAddTool({ config: makeCfg(false), agentSessionKey: "test_session" });
    const result = await tool!.execute("call_2", { content: "Something strictly local." });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed).toMatchObject({ federated: false });
    expect(fs.appendFile).toHaveBeenCalled();
    expect(mem0AddMemory).not.toHaveBeenCalled();
  });

  // ─── Failure resilience ───────────────────────────────────────────────────────

  it("returns success + federated:false when Mem0 write fails but local succeeds", async () => {
    // Mem0 throws, but fs writes succeed
    const { mem0AddMemory } = setupMocks(() =>
      Promise.reject(new Error("Mem0 connection refused")),
    );

    const tool = createMemoryAddTool({ config: makeCfg(true), agentSessionKey: "session_a" });
    const result = await tool!.execute("call_3", { content: "Important fact." });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    // Local write must succeed even when Mem0 fails
    expect(parsed).toMatchObject({ success: true });
    // federated is set before the promise rejection propagates (fire-and-forget)
    expect(mem0AddMemory).toHaveBeenCalled();
    expect(fs.appendFile).toHaveBeenCalled();
  });

  it("returns success:false when the local file system write fails", async () => {
    setupMocks();
    // Override mkdir to throw
    vi.spyOn(fs, "mkdir").mockRejectedValue(new Error("EACCES: permission denied"));

    const tool = createMemoryAddTool({ config: makeCfg(true), agentSessionKey: "session_b" });
    const result = await tool!.execute("call_4", { content: "Cannot write this." });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed).toMatchObject({ success: false });
    expect(parsed.error).toContain("permission denied");
  });

  it("records localPath with YYYY-MM-DD filename", async () => {
    setupMocks();

    const tool = createMemoryAddTool({ config: makeCfg(false), agentSessionKey: "s" });
    const result = await tool!.execute("call_5", { content: "Date check." });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);

    expect(parsed.localPath).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
  });
});
