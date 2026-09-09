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

  it.each([
    {
      scenario: "ordinary file truncation",
      name: "AGENTS.md",
      rawChars: 25_000,
      injectedChars: 20_000,
      maxChars: 20_000,
      heading: "Workspace bootstrap files exceed limits and will be truncated:",
      fileLine: "- AGENTS.md: 25,000 raw / 20,000 injected (20% truncated; max/file)",
      totalLine: "Total bootstrap injected chars: 20,000 (13% of max/total 150,000).",
    },
    {
      scenario: "fixed USER cap truncation",
      name: "USER.md",
      rawChars: 5_000,
      injectedChars: 3_999,
      maxChars: 20_000,
      heading: "Workspace bootstrap files exceed limits and will be truncated:",
      fileLine: "- USER.md: 5,000 raw / 3,999 injected (20% truncated; max/file)",
      totalLine: "Total bootstrap injected chars: 3,999 (3% of max/total 150,000).",
    },
    {
      scenario: "near the fixed USER cap",
      name: "USER.md",
      rawChars: 3_500,
      injectedChars: 3_500,
      maxChars: 20_000,
      heading: "Workspace bootstrap files are near injection limits:",
      fileLine: "- USER.md: 3,500 chars (88% of max/file 4,000)",
      totalLine: "Total bootstrap injected chars: 3,500 (2% of max/total 150,000).",
    },
    {
      scenario: "near a lower USER limit",
      name: "USER.md",
      rawChars: 1_800,
      injectedChars: 1_800,
      maxChars: 2_000,
      heading: "Workspace bootstrap files are near injection limits:",
      fileLine: "- USER.md: 1,800 chars (90% of max/file 2,000)",
      totalLine: "Total bootstrap injected chars: 1,800 (1% of max/total 150,000).",
    },
    {
      scenario: "near an ordinary configured limit",
      name: "SOUL.md",
      rawChars: 18_000,
      injectedChars: 18_000,
      maxChars: 20_000,
      heading: "Workspace bootstrap files are near injection limits:",
      fileLine: "- SOUL.md: 18,000 chars (90% of max/file 20,000)",
      totalLine: "Total bootstrap injected chars: 18,000 (12% of max/total 150,000).",
    },
  ])("reports $scenario with effective limits and actionable advice", async (testCase) => {
    const { name, rawChars, injectedChars, maxChars, heading, fileLine, totalLine } = testCase;
    resolveBootstrapMaxChars.mockReturnValueOnce(maxChars);
    resolveBootstrapContextForDiagnostics.mockResolvedValue({
      bootstrapFiles: [
        {
          name,
          path: `/tmp/workspace/${name}`,
          content: "a".repeat(rawChars),
          missing: false,
        },
      ],
      contextFiles: [{ path: `/tmp/workspace/${name}`, content: "a".repeat(injectedChars) }],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(note).toHaveBeenCalledTimes(1);
    const [message, title] = note.mock.calls[0] ?? [];
    expect(title).toBe("Bootstrap file size");
    expect(message).toBe(
      [
        heading,
        fileLine,
        totalLine,
        `Total bootstrap raw chars (before truncation): ${rawChars.toLocaleString("en-US")}.`,
        "",
        "- Tip: Shorten bootstrap files; see https://docs.openclaw.ai/concepts/agent-workspace for per-file caps and configurable budgets.",
      ].join("\n"),
    );
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
        "- Tip: Shorten bootstrap files; see https://docs.openclaw.ai/concepts/agent-workspace for per-file caps and configurable budgets.",
      ].join("\n"),
    );
  });

  it("threads the default agent id through bootstrap size resolution", async () => {
    resolveDefaultAgentId.mockReturnValueOnce("custom-agent");
    listAgentIds.mockReturnValueOnce(["custom-agent"]);
    resolveBootstrapContextForDiagnostics.mockResolvedValue({
      bootstrapFiles: [],
      contextFiles: [],
    });
    await noteBootstrapFileSize({} as OpenClawConfig);
    expect(resolveBootstrapMaxChars).toHaveBeenCalledWith(expect.anything(), "custom-agent");
    expect(resolveBootstrapTotalMaxChars).toHaveBeenCalledWith(expect.anything(), "custom-agent");
    expect(resolveBootstrapContextForDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "custom-agent" }),
    );
  });

  it("stays silent when files are comfortably within limits", async () => {
    resolveBootstrapContextForDiagnostics.mockResolvedValue({
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
