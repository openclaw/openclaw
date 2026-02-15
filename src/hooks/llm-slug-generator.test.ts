import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveAgentDir: () => "/tmp/agent",
}));

const mockRunEmbeddedPiAgent = vi.fn().mockResolvedValue({
  payloads: [{ text: "bug-fix" }],
});

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (...args: unknown[]) => mockRunEmbeddedPiAgent(...args),
}));

import { generateSlugViaLLM } from "./llm-slug-generator.js";

describe("generateSlugViaLLM", () => {
  beforeEach(() => {
    mockRunEmbeddedPiAgent.mockClear();
    mockRunEmbeddedPiAgent.mockResolvedValue({ payloads: [{ text: "bug-fix" }] });
  });

  it("passes configured primary model to runEmbeddedPiAgent (#14272)", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "google/gemini-3-flash-preview" },
          workspace: "/tmp/workspace",
        },
      },
    };

    await generateSlugViaLLM({
      sessionContent: "user: Hello\nassistant: Hi there",
      cfg,
    });

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "google",
        model: "gemini-3-flash-preview",
      }),
    );
  });

  it("falls back to default Anthropic model when no primary is configured", async () => {
    const cfg = {
      agents: { defaults: { workspace: "/tmp/workspace" } },
    };

    await generateSlugViaLLM({
      sessionContent: "user: Hello\nassistant: Hi there",
      cfg,
    });

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-opus-4-6",
      }),
    );
  });

  it("returns cleaned slug from LLM response", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({
      payloads: [{ text: "  Bug Fix!  " }],
    });

    const slug = await generateSlugViaLLM({
      sessionContent: "user: fix a bug",
      cfg: { agents: { defaults: { workspace: "/tmp/workspace" } } },
    });

    expect(slug).toBe("bug-fix");
  });

  it("returns null when LLM returns no payloads", async () => {
    mockRunEmbeddedPiAgent.mockResolvedValueOnce({ payloads: [] });

    const slug = await generateSlugViaLLM({
      sessionContent: "user: hello",
      cfg: { agents: { defaults: { workspace: "/tmp/workspace" } } },
    });

    expect(slug).toBeNull();
  });

  it("returns null when LLM throws", async () => {
    mockRunEmbeddedPiAgent.mockRejectedValueOnce(new Error("FailoverError"));

    const slug = await generateSlugViaLLM({
      sessionContent: "user: hello",
      cfg: { agents: { defaults: { workspace: "/tmp/workspace" } } },
    });

    expect(slug).toBeNull();
  });
});
