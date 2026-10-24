import { beforeEach, expect, it, vi } from "vitest";
import { buildBootstrapContextFiles } from "../agents/embedded-agent-helpers/bootstrap.js";
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

// mock-isolation: Capture Doctor diagnostics without writing to the operator's terminal.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId: resolveDefaultAgentId,
}));

vi.mock("../agents/bootstrap-files-diagnostics.js", () => ({
  resolveBootstrapContextForDiagnostics,
}));

vi.mock("../agents/embedded-agent-helpers/bootstrap.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/embedded-agent-helpers/bootstrap.js")>(
    "../agents/embedded-agent-helpers/bootstrap.js",
  )),
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
}));

import { noteBootstrapFileSize } from "./doctor-bootstrap-size.js";

function bootstrapFile(name: string, size: number, filePath = `/tmp/workspace/${name}`) {
  return { name, path: filePath, content: "a".repeat(size), missing: false };
}

function context(bootstrapFiles: ReturnType<typeof bootstrapFile>[], sizes: number[]) {
  return {
    bootstrapFiles,
    contextFiles: bootstrapFiles.flatMap(({ path, content }, i) =>
      sizes[i] ? [{ path, content: content.slice(0, sizes[i]) }] : [],
    ),
  };
}

async function message() {
  await noteBootstrapFileSize({});
  expect(note).toHaveBeenCalledTimes(1);
  return note.mock.calls[0]?.[0];
}

beforeEach(() => {
  note.mockClear();
  resolveBootstrapContextForDiagnostics.mockReset();
  resolveBootstrapContextForDiagnostics.mockResolvedValue(context([], []));
  listAgentIds.mockReturnValue(["main"]);
});

it("reports a budget-dropped file that repeats a sibling basename as fully truncated", async () => {
  resolveBootstrapTotalMaxChars.mockReturnValueOnce(1_000);
  resolveBootstrapContextForDiagnostics.mockResolvedValue(
    context(
      [
        bootstrapFile("AGENTS.md", 1_000),
        bootstrapFile("AGENTS.md", 500, "/tmp/workspace/packages/core/AGENTS.md"),
      ],
      [1_000, 0],
    ),
  );
  expect(await message()).toBe(
    [
      "Workspace bootstrap files exceed limits and will be truncated:",
      "- AGENTS.md: 500 raw / 0 injected (100% truncated; max/total)",
      "  No content from this file reaches the model.",
      "Total bootstrap injected chars: 1,000 (100% of max/total 1,000).",
      "Total bootstrap raw chars (before truncation): 1,500.",
      "",
      "- Tip: tune `agents.entries.*.bootstrapTotalMaxChars` for this agent, or `agents.defaults.bootstrapTotalMaxChars` as fallback, for total-budget limits.",
    ].join("\n"),
  );
});

it("explains the retained excerpts using the real bootstrap output", async () => {
  const bootstrapFiles = [
    {
      ...bootstrapFile("AGENTS.md", 25_000),
      content: "# Rules\n- Never lose rules.\n".repeat(1_000),
    },
    bootstrapFile("SOUL.md", 25_000),
  ];
  resolveBootstrapContextForDiagnostics.mockResolvedValue({
    bootstrapFiles,
    contextFiles: buildBootstrapContextFiles(bootstrapFiles, { maxChars: 20_000 }),
  });
  const text = await message();
  expect(text).toContain(
    "The model receives start/end excerpts as space permits, plus a bounded policy digest when available; other middle text is omitted.",
  );
  expect(text).toContain(
    "The model receives start/end excerpts as space permits; middle text is omitted.",
  );
  expect(text).toContain("agents.defaults.bootstrapMaxChars");
});

it.each([
  { scenario: "near fixed cap", sizes: [3_500], injected: [3_500], cap: 20_000 },
  {
    scenario: "mixed fixed and configurable caps",
    sizes: [5_000, 25_000],
    injected: [4_000, 20_000],
    cap: 20_000,
  },
  { scenario: "lower configured cap", sizes: [5_000], injected: [2_000], cap: 2_000 },
])("explains tuning for $scenario", async ({ sizes, injected, cap }) => {
  resolveBootstrapMaxChars.mockReturnValueOnce(cap);
  resolveBootstrapContextForDiagnostics.mockResolvedValue(
    context(
      sizes.map((size, i) => bootstrapFile(i ? "AGENTS.md" : "USER.md", size)),
      injected,
    ),
  );
  const text = await message();
  const fixedCapTip = "USER.md has a fixed 4,000-character bootstrap cap; keep it compact.";
  const tuningTip = "tune `agents.entries.*.bootstrapMaxChars`";
  if (cap === 2_000) {
    expect(text).toContain(tuningTip);
    expect(text).not.toContain("fixed 4,000-character bootstrap cap");
  } else {
    expect(text).toContain(fixedCapTip);
    if (sizes.length > 1) {
      expect(text).toContain(tuningTip);
    } else {
      expect(text).toContain("Workspace bootstrap files are near configured limits:");
      expect(text).toContain("- USER.md: 3,500 chars (88% of max/file 4,000)");
      expect(text).not.toContain("bootstrapMaxChars");
    }
  }
});

it("labels a secondary agent whose bootstrap files exceed the limit", async () => {
  listAgentIds.mockReturnValue(["main", "secondary"]);
  resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
  resolveBootstrapContextForDiagnostics.mockImplementation(async ({ agentId }) =>
    context(
      agentId === "secondary"
        ? [bootstrapFile("AGENTS.md", 25_000, "/tmp/secondary/AGENTS.md")]
        : [],
      [20_000],
    ),
  );
  expect(await message()).toContain('Agent "secondary":');
  expect(resolveBootstrapContextForDiagnostics).toHaveBeenCalledTimes(2);
});
