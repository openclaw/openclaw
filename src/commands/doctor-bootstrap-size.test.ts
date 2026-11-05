import { beforeEach, expect, it, vi } from "vitest";
import { buildBootstrapContextFiles } from "../agents/embedded-agent-helpers/bootstrap.js";
import type { OpenClawConfig } from "../config/config.js";
import { noteBootstrapFileSize } from "./doctor-bootstrap-size.js";

const { note, diagnostics } = vi.hoisted(() => ({ note: vi.fn(), diagnostics: vi.fn() }));
// mock-isolation: Capture Doctor diagnostics without writing to the operator's terminal.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));
// mock-isolation: Supply synthetic bootstrap files without discovering operator workspace files.
vi.mock("../agents/bootstrap-files-diagnostics.js", () => ({
  resolveBootstrapContextForDiagnostics: diagnostics,
}));
beforeEach(() => {
  note.mockClear();
  diagnostics.mockReset();
});

function file(name: string, size: number, path = `/tmp/workspace/${name}`) {
  return { name, path, content: "a".repeat(size), missing: false };
}
async function message(
  bootstrapFiles: ReturnType<typeof file>[],
  sizes: number[],
  defaults: NonNullable<OpenClawConfig["agents"]>["defaults"] = {},
) {
  diagnostics.mockResolvedValue({
    bootstrapFiles,
    contextFiles: bootstrapFiles.flatMap(({ path, content }, i) =>
      sizes[i] ? [{ path, content: content.slice(0, sizes[i]) }] : [],
    ),
  });
  await noteBootstrapFileSize({
    agents: { entries: { main: { workspace: "/tmp/workspace" } }, defaults },
  });
  expect(note).toHaveBeenCalledOnce();
  return note.mock.calls[0]![0];
}

it("reports a budget-dropped file without claiming any content reaches the model", async () => {
  const text = await message(
    [file("AGENTS.md", 1_000), file("AGENTS.md", 500, "/tmp/workspace/nested/AGENTS.md")],
    [1_000, 0],
    { bootstrapTotalMaxChars: 1_000 },
  );
  expect(text).toContain("500 raw / 0 injected (100% truncated; max/total)");
  expect(text).toContain("No content from this file reaches the model.");
  expect(text).toContain("1,000 (100% of max/total 1,000)");
  expect(text).toContain("1,500.");
  expect(text).toContain("agents.entries.*.bootstrapTotalMaxChars");
});

it("explains the retained excerpts using the real bootstrap output", async () => {
  const bootstrapFiles = [
    { ...file("AGENTS.md", 25_000), content: "# Rules\n- Never lose rules.\n".repeat(1_000) },
    file("SOUL.md", 25_000),
  ];
  const injected = buildBootstrapContextFiles(bootstrapFiles, { maxChars: 20_000 });
  diagnostics.mockResolvedValue({ bootstrapFiles, contextFiles: injected });
  await noteBootstrapFileSize({ agents: { entries: { main: {} } } });
  const text = note.mock.calls[0]![0];
  expect(text).toContain(
    "plus a bounded policy digest when available; other middle text is omitted.",
  );
  expect(text).toContain(
    "The model receives start/end excerpts as space permits; middle text is omitted.",
  );
  expect(text).toContain("agents.defaults.bootstrapMaxChars");
});

it.each([
  { sizes: [3_500], injected: [3_500], cap: 20_000, fixed: true, tunable: false },
  { sizes: [5_000, 25_000], injected: [4_000, 20_000], cap: 20_000, fixed: true, tunable: true },
  { sizes: [5_000], injected: [2_000], cap: 2_000, fixed: false, tunable: true },
])("explains fixed and tunable caps: %j", async ({ sizes, injected, cap, fixed, tunable }) => {
  const text = await message(
    sizes.map((size, i) => file(i ? "AGENTS.md" : "USER.md", size)),
    injected,
    { bootstrapMaxChars: cap },
  );
  expect(text.includes("fixed 4,000-character bootstrap cap")).toBe(fixed);
  expect(text.includes("agents.entries.*.bootstrapMaxChars")).toBe(tunable);
  if (!tunable) {
    expect(text).toContain("Workspace bootstrap files are near configured limits:");
    expect(text).toContain("USER.md: 3,500 chars (88% of max/file 4,000)");
    expect(text).not.toContain("bootstrapMaxChars");
  }
});

it("labels a secondary agent whose bootstrap files exceed the limit", async () => {
  const bootstrapFiles = [file("AGENTS.md", 25_000, "/tmp/secondary/AGENTS.md")];
  diagnostics.mockImplementation(async ({ agentId }) => ({
    bootstrapFiles: agentId === "secondary" ? bootstrapFiles : [],
    contextFiles:
      agentId === "secondary"
        ? [{ path: bootstrapFiles[0]!.path, content: "a".repeat(20_000) }]
        : [],
  }));
  await noteBootstrapFileSize({
    agents: {
      entries: { main: { workspace: "/tmp/main" }, secondary: { workspace: "/tmp/secondary" } },
    },
  });
  expect(note).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('Agent "secondary":'),
    "Bootstrap file size",
  );
});
