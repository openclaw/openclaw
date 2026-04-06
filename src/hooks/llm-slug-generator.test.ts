import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { OpenClawConfig } from "../config/config.js";

const {
  mockResolveDefaultAgentId,
  mockResolveAgentWorkspaceDir,
  mockResolveAgentDir,
  mockResolveAgentEffectiveModelPrimary,
  mockBuildModelAliasIndex,
  mockResolveModelRefFromString,
  mockIsCliProvider,
  mockRunEmbeddedPiAgent,
} = vi.hoisted(() => ({
  mockResolveDefaultAgentId: vi.fn(),
  mockResolveAgentWorkspaceDir: vi.fn(),
  mockResolveAgentDir: vi.fn(),
  mockResolveAgentEffectiveModelPrimary: vi.fn(),
  mockBuildModelAliasIndex: vi.fn(),
  mockResolveModelRefFromString: vi.fn(),
  mockIsCliProvider: vi.fn(),
  mockRunEmbeddedPiAgent: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: mockResolveDefaultAgentId,
  resolveAgentWorkspaceDir: mockResolveAgentWorkspaceDir,
  resolveAgentDir: mockResolveAgentDir,
  resolveAgentEffectiveModelPrimary: mockResolveAgentEffectiveModelPrimary,
}));

vi.mock("../agents/model-selection.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../agents/model-selection.js")>();
  return {
    ...orig,
    buildModelAliasIndex: mockBuildModelAliasIndex,
    resolveModelRefFromString: mockResolveModelRefFromString,
    isCliProvider: mockIsCliProvider,
  };
});

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: mockRunEmbeddedPiAgent,
}));

import { generateSlugViaLLM } from "./llm-slug-generator.js";

describe("generateSlugViaLLM", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveDefaultAgentId.mockReturnValue("chief");
    mockResolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw-workspace");
    mockResolveAgentDir.mockReturnValue("/tmp/openclaw-agent");
    mockResolveAgentEffectiveModelPrimary.mockReturnValue("minimax");
    mockBuildModelAliasIndex.mockReturnValue({});
    mockResolveModelRefFromString.mockReturnValue({
      ref: { provider: "minimax", model: "minimax" },
    });
    mockIsCliProvider.mockReturnValue(false);
    mockRunEmbeddedPiAgent.mockResolvedValue({ payloads: [{ text: "Vendor Pitch" }] });
  });

  it("uses lightweight slug generation defaults", async () => {
    const slug = await generateSlugViaLLM({
      sessionContent: "Conversation body",
      cfg: {} as OpenClawConfig,
    });

    expect(slug).toBe("vendor-pitch");
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "memory",
        thinkLevel: "minimal",
        disableTools: true,
        timeoutMs: 45_000,
      }),
    );
  });

  it("reads llmSlugTimeoutMs from session-memory hook config", async () => {
    const cfg = {
      hooks: {
        internal: {
          entries: {
            "session-memory": {
              llmSlugTimeoutMs: 90_000,
            },
          },
        },
      },
    } as OpenClawConfig;

    await generateSlugViaLLM({
      sessionContent: "Conversation body",
      cfg,
    });

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 90_000,
      }),
    );
  });

  it("clamps llmSlugTimeoutMs to safe bounds", async () => {
    const cfg = {
      hooks: {
        internal: {
          entries: {
            "session-memory": {
              llmSlugTimeoutMs: 1_000,
            },
          },
        },
      },
    } as OpenClawConfig;

    await generateSlugViaLLM({
      sessionContent: "Conversation body",
      cfg,
    });

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 5_000,
      }),
    );
  });

  it("falls back to default embedded provider when primary model is CLI backend", async () => {
    mockResolveModelRefFromString.mockReturnValue({
      ref: { provider: "claude-cli", model: "sonnet" },
    });
    mockIsCliProvider.mockReturnValue(true);

    await generateSlugViaLLM({
      sessionContent: "Conversation body",
      cfg: {} as OpenClawConfig,
    });

    expect(mockRunEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: DEFAULT_PROVIDER,
        model: DEFAULT_MODEL,
      }),
    );
  });
});
