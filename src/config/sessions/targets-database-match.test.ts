import fsSync from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isConfiguredAgentDatabaseTarget } from "./targets.js";

// The gateway boot database preflight calls this once per candidate row with the configured
// targets first, so file probes on the per-target path are paid per (row, target) pair.
afterEach(() => {
  vi.restoreAllMocks();
});

describe("isConfiguredAgentDatabaseTarget", () => {
  it("answers an exact configured path without touching the filesystem", () => {
    const targets = Array.from({ length: 200 }, (_, index) => ({
      agentId: `agent-${index}`,
      path: `/state/agents/agent-${index}/openclaw-agent.sqlite`,
    }));
    const statSync = vi.spyOn(fsSync, "statSync");

    const matched = isConfiguredAgentDatabaseTarget(
      targets,
      "agent-199",
      "/state/agents/agent-199/openclaw-agent.sqlite",
    );

    expect(matched).toBe(true);
    expect(statSync).not.toHaveBeenCalled();
  });

  it("probes each target at most once per row instead of once per target pair", () => {
    const targets = Array.from({ length: 200 }, (_, index) => ({
      path: `/state/agents/agent-${index}/openclaw-agent.sqlite`,
    }));
    // Every configured target exists, and the row does not: the stock loop stat'd the row once
    // per target before bailing, so the row probe is what scales with the target count.
    const statSync = vi
      .spyOn(fsSync, "statSync")
      .mockReturnValue({ isFile: () => true } as unknown as fsSync.Stats);

    for (let row = 0; row < 50; row += 1) {
      expect(
        isConfiguredAgentDatabaseTarget(targets, undefined, `/state/rows/row-${row}.sqlite`),
      ).toBe(false);
    }

    const perRow = statSync.mock.calls.length / 50;
    // One probe per target, not two: the row itself is probed at most once for the whole row.
    expect(perRow).toBeLessThanOrEqual(targets.length + 1);
  });

  it("keeps alias detection for a configured path that resolves to the row", () => {
    const exists = new Set([
      "/state/agents/a/openclaw-agent.sqlite",
      "/state/link/openclaw.sqlite",
    ]);
    vi.spyOn(fsSync, "statSync").mockImplementation(((pathname: fsSync.PathLike) =>
      exists.has(String(pathname))
        ? ({ isFile: () => true } as unknown as fsSync.Stats)
        : undefined) as unknown as typeof fsSync.statSync);

    expect(
      isConfiguredAgentDatabaseTarget(
        [{ path: "/state/link/openclaw.sqlite" }],
        undefined,
        "/state/agents/missing/openclaw-agent.sqlite",
      ),
    ).toBe(false);
  });
});
