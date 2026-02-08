import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(),
}));

describe("llm-slug-generator", () => {
  it("uses the configured default model when generating slugs", async () => {
    const { runEmbeddedPiAgent } = await import("../agents/pi-embedded.js");
    const mockRun = vi.mocked(runEmbeddedPiAgent);
    mockRun.mockResolvedValue({
      payloads: [{ text: "Slug-Example" }],
    } as Awaited<ReturnType<typeof runEmbeddedPiAgent>>);

    const { generateSlugViaLLM } = await import("./llm-slug-generator.js");

    const tempDir = await makeTempWorkspace("openclaw-slug-gen-");
    const agentDir = path.join(tempDir, "agents", "main", "agent");
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tempDir,
          model: { primary: "zai/glm-4.7" },
        },
        list: [{ id: "main", default: true, agentDir, workspace: tempDir }],
      },
    };

    const slug = await generateSlugViaLLM({ sessionContent: "hello", cfg });

    expect(slug).toBe("slug-example");
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "zai",
        model: "glm-4.7",
        agentDir,
      }),
    );
  });
});
