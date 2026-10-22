import { describe, expect, it, vi } from "vitest";
import { createCoreHealthChecks } from "./doctor-core-checks.js";

const runtime = { log() {}, error() {}, exit() {} };

const collectNotes = vi.hoisted(() =>
  vi.fn<(workspaceDir: string) => Promise<readonly string[]>>(async () => []),
);

vi.mock("../commands/doctor-workspace-suggestions.js", () => ({
  async *collectWorkspaceSuggestionNotes(workspaceDir: string) {
    yield* await collectNotes(workspaceDir);
  },
}));

function detect(
  workspaces: Record<string, string>,
  notes: (dir: string) => Promise<readonly string[]>,
) {
  collectNotes.mockImplementation(notes);
  const check = createCoreHealthChecks().find(
    (candidate) => candidate.id === "core/doctor/workspace-suggestions",
  );
  if (!check || !("detect" in check)) {
    throw new Error("workspace suggestions check not found");
  }
  const entries = Object.fromEntries(
    Object.entries(workspaces).map(([id, workspace]) => [id, { workspace }]),
  );
  return check.detect({
    mode: "lint",
    runtime,
    cfg: { agents: { entries } },
  });
}

const finding = (target: string, message: string) =>
  expect.objectContaining({ target, message: `Agent "${target}": ${message}` });

describe("core/doctor/workspace-suggestions", () => {
  it("labels secondary-agent findings with structured targets", async () => {
    const findings = await detect(
      { main: "/tmp/main", secondary: "/tmp/secondary" },
      async (workspaceDir) =>
        workspaceDir === "/tmp/secondary"
          ? ["- Back up this workspace.", "Memory system not found in workspace."]
          : [],
    );

    expect(findings).toEqual([
      finding("secondary", "- Back up this workspace."),
      finding("secondary", "Memory system not found in workspace."),
    ]);
  });

  it("keeps shared workspace suggestions agent-scoped", async () => {
    const findings = await detect({ main: "/tmp/shared", secondary: "/tmp/shared" }, async () => [
      "Memory system not found in workspace.",
    ]);

    expect(findings).toEqual([
      finding("main", "Memory system not found in workspace."),
      finding("secondary", "Memory system not found in workspace."),
    ]);
  });

  it("preserves the explicit empty-roster failure", async () => {
    await expect(detect({}, async () => [])).rejects.toThrow("No agents configured");
  });
});
