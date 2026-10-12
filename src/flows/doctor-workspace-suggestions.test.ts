import { describe, expect, it, vi } from "vitest";
import { createCoreHealthChecks } from "./doctor-core-checks.js";
import type { HealthCheck } from "./health-checks.js";

const runtime = { log() {}, error() {}, exit() {} };

const collectNotes = vi.hoisted(() =>
  vi.fn<(workspaceDir: string) => Promise<readonly string[]>>(async () => []),
);

vi.mock("../commands/doctor-workspace-suggestions.js", () => ({
  async *collectWorkspaceSuggestionNotes(workspaceDir: string) {
    yield* await collectNotes(workspaceDir);
  },
}));

function createWorkspaceSuggestionsCheck(
  collectWorkspaceSuggestionNotes: (workspaceDir: string) => Promise<readonly string[]>,
): HealthCheck {
  collectNotes.mockImplementation(collectWorkspaceSuggestionNotes);
  const check = createCoreHealthChecks().find(
    (candidate) => candidate.id === "core/doctor/workspace-suggestions",
  );
  if (!check || !("detect" in check)) {
    throw new Error("workspace suggestions check not found");
  }
  return check;
}

describe("core/doctor/workspace-suggestions", () => {
  it("labels secondary-agent findings with structured targets", async () => {
    const check = createWorkspaceSuggestionsCheck(async (workspaceDir) =>
      workspaceDir === "/tmp/secondary"
        ? ["- Back up this workspace.", "Memory system not found in workspace."]
        : [],
    );

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        agents: {
          entries: {
            main: { workspace: "/tmp/main" },
            secondary: { workspace: "/tmp/secondary" },
          },
        },
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        message: 'Agent "secondary": - Back up this workspace.',
        target: "secondary",
      }),
      expect.objectContaining({
        message: 'Agent "secondary": Memory system not found in workspace.',
        target: "secondary",
      }),
    ]);
  });

  it("keeps shared workspace suggestions agent-scoped", async () => {
    const check = createWorkspaceSuggestionsCheck(async () => [
      "Memory system not found in workspace.",
    ]);

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        agents: {
          entries: {
            main: { workspace: "/tmp/shared" },
            secondary: { workspace: "/tmp/shared" },
          },
        },
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        message: 'Agent "main": Memory system not found in workspace.',
        target: "main",
      }),
      expect.objectContaining({
        message: 'Agent "secondary": Memory system not found in workspace.',
        target: "secondary",
      }),
    ]);
  });

  it("preserves the explicit empty-roster failure", async () => {
    const check = createWorkspaceSuggestionsCheck(async () => []);

    await expect(
      check.detect({
        mode: "lint",
        runtime,
        cfg: { agents: { entries: {} } },
      }),
    ).rejects.toThrow("No agents configured");
  });
});
