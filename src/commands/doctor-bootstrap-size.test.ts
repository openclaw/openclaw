// Doctor bootstrap-size tests cover prompt-context budget warnings and note rendering.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const note = vi.hoisted(() => vi.fn());
const resolveAgentWorkspaceDir = vi.hoisted(() =>
  vi.fn<(_cfg: OpenClawConfig, agentId: string) => string>(() => "/tmp/workspace"),
);
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));
const listAgentIds = vi.hoisted(() => vi.fn(() => ["main"]));
const resolveBootstrapContextForDiagnostics = vi.hoisted(() => vi.fn());
const resolveBootstrapMaxChars = vi.hoisted(() => vi.fn(() => 20_000));
const resolveBootstrapTotalMaxChars = vi.hoisted(() => vi.fn(() => 150_000));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId: resolveDefaultAgentId,
}));

vi.mock("../agents/bootstrap-files-diagnostics.js", () => ({
  resolveBootstrapContextForDiagnostics,
}));

vi.mock("../agents/embedded-agent-helpers.js", () => ({
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
}));

import { noteBootstrapFileSize } from "./doctor-bootstrap-size.js";

describe("noteBootstrapFileSize", () => {
  beforeEach(() => {
    note.mockClear();
    resolveBootstrapContextForDiagnostics.mockReset();
    resolveBootstrapContextForDiagnostics.mockResolvedValue({
      bootstrapFiles: [],
      contextFiles: [],
    });
    listAgentIds.mockReturnValue(["main"]);
  });

  it("reports a budget-dropped file that repeats a sibling basename as fully truncated", async () => {
    resolveBootstrapTotalMaxChars.mockReturnValueOnce(1_000);
    resolveBootstrapContextForDiagnostics.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(1_000),
          missing: false,
        },
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/packages/core/AGENTS.md",
          content: "b".repeat(500),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "a".repeat(1_000) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).toHaveBeenCalledTimes(1);
    expect(note.mock.calls[0]?.[0]).toBe(
      [
        "Workspace bootstrap files exceed limits and will be truncated:",
        "- AGENTS.md: 500 raw / 0 injected (100% truncated; max/total)",
        "Total bootstrap injected chars: 1,000 (100% of max/total 1,000).",
        "Total bootstrap raw chars (before truncation): 1,500.",
        "",
        "- Tip: tune `agents.entries.*.bootstrapTotalMaxChars` for this agent, or `agents.defaults.bootstrapTotalMaxChars` as fallback, for total-budget limits.",
      ].join("\n"),
    );
  });

  it("explains the fixed cap for a near-limit, untruncated USER.md", async () => {
    resolveBootstrapContextForDiagnostics.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "USER.md",
          path: "/tmp/workspace/USER.md",
          content: "u".repeat(3_500),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/USER.md", content: "u".repeat(3_500) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] ?? [];
    expect(message).toContain("Workspace bootstrap files are near configured limits:");
    expect(message).toContain("- USER.md: 3,500 chars (88% of max/file 4,000)");
    expect(message).toContain(
      "USER.md has a fixed 4,000-character bootstrap cap; keep it compact.",
    );
    expect(message).not.toContain("bootstrapMaxChars");
  });

  it("keeps the tuning tip when another file hits a configurable per-file limit", async () => {
    resolveBootstrapContextForDiagnostics.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "USER.md",
          path: "/tmp/workspace/USER.md",
          content: "u".repeat(5_000),
          missing: false,
        },
        {
          name: "AGENTS.md",
          path: "/tmp/workspace/AGENTS.md",
          content: "a".repeat(25_000),
          missing: false,
        },
      ],
      contextFiles: [
        { path: "/tmp/workspace/USER.md", content: "u".repeat(4_000) },
        { path: "/tmp/workspace/AGENTS.md", content: "a".repeat(20_000) },
      ],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] ?? [];
    expect(message).toContain(
      "USER.md has a fixed 4,000-character bootstrap cap; keep it compact.",
    );
    expect(message).toContain("tune `agents.entries.*.bootstrapMaxChars`");
  });

  it("keeps the tuning tip when USER.md sits under an explicitly lower configured cap", async () => {
    resolveBootstrapMaxChars.mockReturnValueOnce(2_000);
    resolveBootstrapContextForDiagnostics.mockResolvedValue({
      bootstrapFiles: [
        {
          name: "USER.md",
          path: "/tmp/workspace/USER.md",
          content: "u".repeat(5_000),
          missing: false,
        },
      ],
      contextFiles: [{ path: "/tmp/workspace/USER.md", content: "u".repeat(2_000) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).toHaveBeenCalledTimes(1);
    const [message] = note.mock.calls[0] ?? [];
    expect(message).toContain("tune `agents.entries.*.bootstrapMaxChars`");
    expect(message).not.toContain("fixed 4,000-character bootstrap cap");
  });

  it("labels a secondary agent whose bootstrap files exceed the limit", async () => {
    listAgentIds.mockReturnValue(["main", "secondary"]);
    resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
    resolveBootstrapContextForDiagnostics.mockImplementation(async ({ agentId }) => ({
      bootstrapFiles:
        agentId === "secondary"
          ? [
              {
                name: "AGENTS.md",
                path: "/tmp/secondary/AGENTS.md",
                content: "a".repeat(25_000),
                missing: false,
              },
            ]
          : [],
      contextFiles:
        agentId === "secondary"
          ? [{ path: "/tmp/secondary/AGENTS.md", content: "a".repeat(20_000) }]
          : [],
    }));

    await noteBootstrapFileSize({} as OpenClawConfig);

    expect(note).toHaveBeenCalledTimes(1);
    expect(note.mock.calls[0]?.[0]).toContain('Agent "secondary":');
    expect(resolveBootstrapContextForDiagnostics).toHaveBeenCalledTimes(2);
  });
});
