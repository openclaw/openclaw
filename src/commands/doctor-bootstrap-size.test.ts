import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const resolveBootstrapContextForRun = vi.hoisted(() => vi.fn());
const resolveBootstrapMaxChars = vi.hoisted(() => vi.fn(() => 20_000));
const resolveBootstrapTier = vi.hoisted(() => vi.fn(() => "standard"));
const resolveBootstrapTotalMaxChars = vi.hoisted(() => vi.fn(() => 150_000));

vi.mock("../terminal/note.js", () => ({
  note,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
}));

vi.mock("../agents/bootstrap-files.js", () => ({
  resolveBootstrapContextForRun,
}));

vi.mock("../agents/pi-embedded-helpers.js", () => ({
  resolveBootstrapMaxChars,
  resolveBootstrapTier,
  resolveBootstrapTotalMaxChars,
}));

import { noteBootstrapFileSize } from "./doctor-bootstrap-size.js";

describe("noteBootstrapFileSize", () => {
  beforeEach(() => {
    note.mockClear();
    resolveBootstrapTier.mockReset();
    resolveBootstrapTier.mockReturnValue("standard");
    resolveBootstrapContextForRun.mockReset();
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [],
      contextFiles: [],
    });
  });

  it("emits a warning when bootstrap files are truncated", async () => {
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(25_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(20_000) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] ?? [];
    expect(String(title)).toBe("Bootstrap file size");
    expect(String(message)).toContain("will be truncated");
    expect(String(message)).toContain("AGENTS.md");
    expect(String(message)).toContain("max/file");
  });

  it("stays silent when files are comfortably within limits", async () => {
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(1_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(1_000) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).not.toHaveBeenCalled();
  });

  it("warns for large bootstrap context on a loopback primary model", async () => {
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(9_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(9_000) }],
    });

    await noteBootstrapFileSize({
      agents: { defaults: { model: { primary: "local/my-model" } } },
      models: {
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:8000/v1",
            models: [],
          },
        },
      },
    } as OpenClawConfig);

    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] ?? [];
    expect(String(title)).toBe("Bootstrap prompt pressure");
    expect(String(message)).toContain("loopback local model");
    expect(String(message)).toContain("agents.defaults.bootstrapTier");
    expect(String(message)).toContain("minimal");
  });

  it("does not warn for large bootstrap context when minimal bootstrap tier is configured", async () => {
    resolveBootstrapTier.mockReturnValue("minimal");
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(9_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(9_000) }],
    });

    await noteBootstrapFileSize({
      agents: { defaults: { model: { primary: "local/my-model" }, bootstrapTier: "minimal" } },
      models: {
        providers: {
          local: {
            baseUrl: "http://127.0.0.1:8000/v1",
            models: [],
          },
        },
      },
    } as OpenClawConfig);

    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn for large bootstrap context on a hosted primary model", async () => {
    resolveBootstrapContextForRun.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(9_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(9_000) }],
    });

    await noteBootstrapFileSize({
      agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [],
          },
        },
      },
    } as OpenClawConfig);

    expect(note).not.toHaveBeenCalled();
  });
});
