import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const { resolveAgentEffectiveModelPrimaryMock, runEmbeddedPiAgentMock, runCliAgentMock } =
  vi.hoisted(() => ({
    resolveAgentEffectiveModelPrimaryMock: vi.fn<() => string | null>(() => null),
    runEmbeddedPiAgentMock: vi.fn(),
    runCliAgentMock: vi.fn(),
  }));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: vi.fn(() => "main"),
  resolveAgentWorkspaceDir: vi.fn(() => path.join(os.tmpdir(), "openclaw-slug-workspace")),
  resolveAgentDir: vi.fn(() => path.join(os.tmpdir(), "openclaw-slug-agent")),
  resolveAgentEffectiveModelPrimary: resolveAgentEffectiveModelPrimaryMock,
}));

vi.mock("../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => runCliAgentMock(...args),
}));

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (...args: unknown[]) => runEmbeddedPiAgentMock(...args),
}));

import { generateSlugViaLLM } from "./llm-slug-generator.js";

describe("generateSlugViaLLM", () => {
  beforeEach(() => {
    resolveAgentEffectiveModelPrimaryMock.mockReset();
    resolveAgentEffectiveModelPrimaryMock.mockReturnValue(null);
    runCliAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockReset();
    runEmbeddedPiAgentMock.mockResolvedValue({
      payloads: [{ text: "test-slug" }],
    });
  });

  it("keeps the helper default timeout when no agent timeout is configured", async () => {
    await generateSlugViaLLM({
      sessionContent: "hello",
      cfg: {} as OpenClawConfig,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        timeoutMs: 15_000,
      }),
    );
  });

  it("honors configured agent timeoutSeconds for slow local providers", async () => {
    await generateSlugViaLLM({
      sessionContent: "hello",
      cfg: {
        agents: {
          defaults: {
            timeoutSeconds: 500,
          },
        },
      } as OpenClawConfig,
    });

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledOnce();
    expect(runEmbeddedPiAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        timeoutMs: 500_000,
      }),
    );
  });

  it("uses runCliAgent for CLI-backed default models and preserves timeout resolution", async () => {
    resolveAgentEffectiveModelPrimaryMock.mockReturnValue("claude-cli/opus");
    runCliAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Vendor Pitch" }],
      meta: {
        agentMeta: {
          sessionId: "cli-session",
          provider: "claude-cli",
          model: "opus",
        },
      },
    });

    const slug = await generateSlugViaLLM({
      sessionContent: "Discussed the vendor pitch and next steps.",
      cfg: {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
            timeoutSeconds: 500,
          },
        },
      } as OpenClawConfig,
    });

    expect(runCliAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude-cli",
        model: "opus",
        timeoutMs: 500_000,
      }),
    );
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(slug).toBe("vendor-pitch");
  });
});
