import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isAllowedRunHarnessArtifactPath,
  listWorkRoutingExplanations,
  summarizeDurableRunFromArtifacts,
} from "./durable-work-supervision.js";

describe("durable work supervision", () => {
  let tempRoot: string | undefined;

  afterEach(() => {
    if (tempRoot) {
      rmSync(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  function createRunRoot(): string {
    tempRoot = mkdtempSync(join(tmpdir(), "openclaw-run-harness-"));
    for (const dir of [
      "failures",
      "gates",
      "logs",
      "prompts",
      "receipts",
      "reviews",
      "verification",
    ]) {
      mkdirSync(join(tempRoot, dir), { recursive: true });
    }
    writeFileSync(
      join(tempRoot, "task-graph.json"),
      `${JSON.stringify(
        {
          tasks: [
            {
              id: "T005",
              title: "Durable work supervision",
              status: "blocked",
              risk: "medium",
              depends_on: ["T004"],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(tempRoot, "stage-manifest.json"),
      `${JSON.stringify(
        {
          run_id: "run-123",
          stages: [
            { id: "S005", task_id: "T005", title: "Durable work supervision", status: "pending" },
          ],
          gates: ["G001-source-release"],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(tempRoot, "gates", "G001-source-release.md"),
      "# Source release\nStatus: pending\n",
    );
    writeFileSync(
      join(tempRoot, "failures", "T005-blocker.md"),
      "# T005 blocker\nWaiting for T004.\n",
    );
    writeFileSync(join(tempRoot, "receipts", "T005.md"), "# T005 receipt\n");
    writeFileSync(join(tempRoot, "reviews", "T005.md"), "# T005 review\n");
    writeFileSync(join(tempRoot, "verification", "T005.md"), "# T005 verification\n");
    writeFileSync(join(tempRoot, "logs", "raw-transcript.md"), "private raw transcript");
    writeFileSync(join(tempRoot, "prompts", "developer-T005.md"), "private prompt");
    return tempRoot;
  }

  it("summarizes durable run state from allowed artifacts only", () => {
    const runRoot = createRunRoot();

    const summary = summarizeDurableRunFromArtifacts({ runRoot });

    expect(summary).toMatchObject({
      source: "run-harness-safe-artifacts",
      runId: "run-123",
      safety: {
        gatesAutoApproved: false,
      },
    });
    expect(summary.tasks).toEqual([
      {
        id: "T005",
        title: "Durable work supervision",
        status: "blocked",
        risk: "medium",
        dependsOn: ["T004"],
      },
    ]);
    expect(summary.gates).toEqual([
      expect.objectContaining({
        id: "G001-source-release",
        status: "pending",
        requiresExplicitApproval: true,
        canAutoApprove: false,
      }),
    ]);
    expect(summary.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "task", id: "T005", status: "blocked" }),
        expect.objectContaining({ kind: "failure", id: "T005-blocker" }),
        expect.objectContaining({ kind: "gate", id: "G001-source-release", status: "pending" }),
      ]),
    );
    expect(summary.evidence).toEqual({
      receipts: ["receipts/T005.md"],
      reviews: ["reviews/T005.md"],
      verification: ["verification/T005.md"],
    });
    expect(summary.sourcesRead).not.toEqual(expect.arrayContaining(["logs/raw-transcript.md"]));
    expect(summary.sourcesRead).not.toEqual(expect.arrayContaining(["prompts/developer-T005.md"]));
    expect(summary.loadErrors).toEqual([]);
  });

  it("rejects private or raw artifact paths", () => {
    const runRoot = createRunRoot();

    expect(isAllowedRunHarnessArtifactPath(runRoot, join(runRoot, "task-graph.json"))).toBe(true);
    expect(
      isAllowedRunHarnessArtifactPath(runRoot, join(runRoot, "logs", "raw-transcript.md")),
    ).toBe(false);
    expect(isAllowedRunHarnessArtifactPath(runRoot, join(runRoot, "state.sqlite"))).toBe(false);
    expect(isAllowedRunHarnessArtifactPath(runRoot, join(runRoot, "auth", "token.json"))).toBe(
      false,
    );
  });

  it("rejects safe-looking markdown symlinks that escape the run root", () => {
    const runRoot = createRunRoot();
    const outside = mkdtempSync(join(tmpdir(), "openclaw-run-harness-outside-"));
    writeFileSync(join(outside, "secret.md"), "# Secret\noutside content\n");
    symlinkSync(join(outside, "secret.md"), join(runRoot, "gates", "G999-secret.md"));
    try {
      expect(
        isAllowedRunHarnessArtifactPath(runRoot, join(runRoot, "gates", "G999-secret.md")),
      ).toBe(false);

      const summary = summarizeDurableRunFromArtifacts({ runRoot });

      expect(summary.gates.map((gate) => gate.id)).not.toContain("G999-secret");
      expect(summary.sourcesRead).not.toContain("gates/G999-secret.md");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("explains all execution routing lanes", () => {
    expect(listWorkRoutingExplanations().map((entry) => entry.lane)).toEqual([
      "direct-codex",
      "codex-superpowers-harness",
      "codex-multi-agent-harness",
      "run-harness",
      "ralph",
    ]);
  });
});
