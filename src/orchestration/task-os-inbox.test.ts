import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCanonicalTaskWork } from "./task-os-arbitration.js";
import { buildDefaultArtifactDrafts } from "./task-os-artifacts.js";
import {
  buildTaskOsInboxSnapshot,
  renderSlackHomeQueueSummary,
  renderTelegramApprovalPacket,
} from "./task-os-inbox.js";
import { buildChiefOfStaffSynthesis } from "./task-os-synthesis.js";

function buildTask() {
  const now = "2026-04-09T12:00:00.000Z";
  return {
    id: "task-inbox",
    title: "Reply to launch blocker",
    status: "pending" as const,
    dependencies: [],
    acceptanceCriteria: [],
    evidence: [
      {
        id: "e1",
        summary: "NotebookLM evidence packet",
        provenanceTier: "research_workbench" as const,
        promotionStatus: "research_only" as const,
        createdAt: now,
      },
    ],
    verificationHistory: [],
    canonicalWork: createCanonicalTaskWork(
      {
        source: {
          sourceKind: "slack",
          signalKind: "mention",
          sourceId: "slack-thread-1",
          idempotencyKey: "slack-1",
          title: "Reply to launch blocker",
          summary: "Stakeholder is waiting on a reply",
          confidence: { score: 0.9, reason: "direct mention" },
          observedAt: now,
        },
      },
      now,
    ),
    createdAt: now,
    updatedAt: now,
  };
}

async function writeRolloutFlags() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbox-rollout-"));
  const file = path.join(dir, "rollout-flags.json");
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        policy_version: "test",
        lanes: [
          { id: "approval_inbox", enabled: true },
          { id: "artifact_adapters", enabled: true },
        ],
      },
      null,
      2,
    ),
  );
  process.env.OPENCLAW_ROLLOUT_FLAGS_PATH = file;
}

describe("task-os inbox", () => {
  it("builds an inbox snapshot with pending approvals and research-only attachments", async () => {
    await writeRolloutFlags();
    const task = buildTask();
    const synthesis = await buildChiefOfStaffSynthesis({ tasks: [task], now: task.createdAt });
    const snapshot = buildTaskOsInboxSnapshot({ tasks: [task], synthesis });
    const priority = synthesis.priorities[0];
    if (!priority) {
      throw new Error("priority missing");
    }
    const expectedDrafts = buildDefaultArtifactDrafts({ task, priority });

    expect(snapshot.topQueue).toHaveLength(1);
    expect(snapshot.topQueue[0]?.pendingApprovals).toHaveLength(
      expectedDrafts.filter((draft) => draft.approval.decision !== "allow").length,
    );
    expect(snapshot.topQueue[0]?.artifactDrafts.map((draft) => draft.kind)).toEqual(
      expectedDrafts.map((draft) => draft.kind),
    );
    expect(snapshot.topQueue[0]?.researchAttachments[0]?.promotionStatus).toBe("research_only");
  });

  it("renders Slack summary lines and Telegram approval packets with artifact versions", async () => {
    await writeRolloutFlags();
    const task = buildTask();
    const synthesis = await buildChiefOfStaffSynthesis({ tasks: [task], now: task.createdAt });
    const snapshot = buildTaskOsInboxSnapshot({ tasks: [task], synthesis });
    const firstItem = snapshot.topQueue[0];
    if (!firstItem) {
      throw new Error("inbox item missing");
    }

    const lines = renderSlackHomeQueueSummary(snapshot);
    expect(lines[0]).toContain("Reply to launch blocker");
    expect(lines[0]).toContain("chief_of_staff");

    const packet = renderTelegramApprovalPacket(firstItem);
    expect(packet).toContain("Approval packet for Reply to launch blocker");
    expect(packet).toContain("research_only attachment: NotebookLM evidence packet");
    for (const draft of firstItem.pendingApprovals) {
      expect(packet).toContain(`version=${draft.version}`);
    }
  });
});
