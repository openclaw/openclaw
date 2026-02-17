import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SubagentRunRecord } from "../subagent-registry.js";
import {
  addSubagentRunForTests,
  getRunById,
  resetSubagentRegistryForTests,
} from "../subagent-registry.js";

let configOverride: OpenClawConfig = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

import { createSessionsTreeTool } from "./sessions-tree-tool.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
let tempStateDir: string | null = null;

function addRun(params: {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  label?: string;
  task?: string;
  createdAt?: number;
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunRecord["outcome"];
  depth?: number;
  completionReport?: SubagentRunRecord["completionReport"];
  latestProgress?: SubagentRunRecord["latestProgress"];
  verification?: SubagentRunRecord["verification"];
  verificationResult?: SubagentRunRecord["verificationResult"];
  verificationState?: SubagentRunRecord["verificationState"];
  retryAttemptedAt?: number;
}) {
  addSubagentRunForTests({
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterDisplayKey: "main",
    task: params.task ?? "task",
    cleanup: "keep",
    label: params.label,
    createdAt: params.createdAt ?? Date.now(),
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    outcome: params.outcome,
    depth: params.depth,
    completionReport: params.completionReport,
    latestProgress: params.latestProgress,
    verification: params.verification,
    verificationResult: params.verificationResult,
    verificationState: params.verificationState,
    retryAttemptedAt: params.retryAttemptedAt,
    childKeys: new Set<string>(),
  } as SubagentRunRecord);
}

beforeEach(async () => {
  configOverride = {
    session: {
      mainKey: "main",
      scope: "per-sender",
    },
  };
  tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-tree-"));
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
  resetSubagentRegistryForTests({ persist: false });
});

afterEach(async () => {
  resetSubagentRegistryForTests({ persist: false });
  if (tempStateDir) {
    await fs.rm(tempStateDir, { recursive: true, force: true });
    tempStateDir = null;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("sessions_tree tool", () => {
  it("builds a nested tree with run status counters", async () => {
    const childA = "agent:main:subagent:a";
    const childB = "agent:main:subagent:b";
    const childC = "agent:main:subagent:c";

    addRun({
      runId: "run-a",
      childSessionKey: childA,
      requesterSessionKey: "main",
      label: "alpha",
      task: "task a",
      createdAt: 1_000,
      startedAt: 1_100,
    });
    addRun({
      runId: "run-b",
      childSessionKey: childB,
      requesterSessionKey: childA,
      label: "beta",
      task: "task b",
      createdAt: 1_200,
      startedAt: 1_300,
      endedAt: 1_900,
      outcome: { status: "ok" },
    });
    addRun({
      runId: "run-c",
      childSessionKey: childC,
      requesterSessionKey: "main",
      label: "gamma",
      task: "task c",
      createdAt: 1_400,
      startedAt: 1_450,
      endedAt: 1_700,
      outcome: { status: "error", error: "boom" },
    });

    const tool = createSessionsTreeTool({ agentSessionKey: "main" });
    const result = await tool.execute("call-tree", {});
    const details = result.details as {
      active: number;
      completed: number;
      total: number;
      tree: Array<{
        key: string;
        status: string;
        runtimeMs: number;
        children: Array<{ key: string; status: string; runtimeMs: number }>;
      }>;
    };

    expect(details.active).toBe(1);
    expect(details.completed).toBe(2);
    expect(details.total).toBe(3);

    const rootA = details.tree.find((node) => node.key === childA);
    expect(rootA?.status).toBe("running");
    expect(rootA?.children).toHaveLength(1);
    expect(rootA?.children[0]?.key).toBe(childB);
    expect(rootA?.children[0]?.status).toBe("completed");
    expect(rootA?.children[0]?.runtimeMs).toBe(600);

    const rootC = details.tree.find((node) => node.key === childC);
    expect(rootC?.status).toBe("error");
    expect(rootC?.runtimeMs).toBe(250);
  });

  it("shows only the caller subtree for subagent sessions", async () => {
    const parent = "agent:main:subagent:parent";
    const child = "agent:main:subagent:child";
    const unrelated = "agent:main:subagent:other";

    addRun({
      runId: "run-parent",
      childSessionKey: parent,
      requesterSessionKey: "main",
      label: "parent",
      task: "parent task",
    });
    addRun({
      runId: "run-child",
      childSessionKey: child,
      requesterSessionKey: parent,
      label: "child",
      task: "child task",
    });
    addRun({
      runId: "run-other",
      childSessionKey: unrelated,
      requesterSessionKey: "main",
      label: "other",
      task: "other task",
    });

    const tool = createSessionsTreeTool({ agentSessionKey: parent });
    const result = await tool.execute("call-subtree", { depth: 0 });
    const details = result.details as {
      total: number;
      tree: Array<{ key: string; children: unknown[] }>;
    };

    expect(details.total).toBe(2);
    expect(details.tree.map((node) => node.key)).toEqual([parent]);
    expect(details.tree[0]?.children).toEqual([]);
  });

  it("projects completion, verification, and latest progress", async () => {
    addRun({
      runId: "run-wave2",
      childSessionKey: "agent:main:subagent:wave2",
      requesterSessionKey: "main",
      label: "wave2",
      task: "wave2",
      createdAt: 1000,
      startedAt: 1000,
      endedAt: 1500,
      outcome: { status: "ok" },
      completionReport: {
        status: "partial",
        confidence: "medium",
        summary: "Primary work done with one warning.",
        artifacts: [{ path: "out/report.md" }],
        warnings: ["Needs follow-up"],
      },
      verification: {
        onFailure: "retry_once",
      },
      verificationState: "failed",
      verificationResult: {
        status: "failed",
        checks: [
          {
            type: "artifact",
            target: "/tmp/out.json",
            passed: false,
            reason: "artifact_not_found",
          },
        ],
        verifiedAt: 1700000000000,
      },
      retryAttemptedAt: 1700000001000,
    });

    const progressPath = path.join(tempStateDir!, "progress", "run-wave2.jsonl");
    await fs.mkdir(path.dirname(progressPath), { recursive: true });
    await fs.writeFile(
      progressPath,
      [
        JSON.stringify({
          runId: "run-wave2",
          phase: "Collecting",
          percentComplete: 30,
          updatedAt: "2026-02-17T00:00:00.000Z",
        }),
        JSON.stringify({
          runId: "run-wave2",
          phase: "Finalizing",
          percentComplete: 95,
          updatedAt: "2026-02-17T00:01:00.000Z",
        }),
      ].join("\n"),
      "utf8",
    );

    const tool = createSessionsTreeTool({ agentSessionKey: "main" });
    const result = await tool.execute("call-wave2", {});
    const details = result.details as {
      tree: Array<{
        key: string;
        latestProgress?: { phase: string; percentComplete?: number; updatedAt: string };
        completion?: {
          status?: string;
          confidence?: string;
          artifactCount?: number;
          warningCount?: number;
        };
        verification?: {
          state?: string;
          status?: string;
          failedCheckCount?: number;
          onFailure?: string;
          retryAttemptedAt?: number;
        };
      }>;
    };

    const node = details.tree.find((entry) => entry.key === "agent:main:subagent:wave2");
    expect(node?.latestProgress).toMatchObject({
      phase: "Finalizing",
      percentComplete: 95,
      updatedAt: "2026-02-17T00:01:00.000Z",
    });
    expect(node?.completion).toMatchObject({
      status: "partial",
      confidence: "medium",
      artifactCount: 1,
      warningCount: 1,
    });
    expect(node?.verification).toMatchObject({
      state: "failed",
      status: "failed",
      failedCheckCount: 1,
      onFailure: "retry_once",
      retryAttemptedAt: 1700000001000,
    });

    expect(getRunById("run-wave2")?.latestProgress).toMatchObject({
      phase: "Finalizing",
      percentComplete: 95,
    });
  });
});
