import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.js";
import { createCanonicalTaskWork } from "./task-os-arbitration.js";
import { applyStructuredArtifact, buildDefaultArtifactDrafts } from "./task-os-artifacts.js";

async function writeControlPlaneFixture(
  home: string,
  options?: { allowStructuredCreate?: boolean },
) {
  const policyDir = path.join(home, "control-plane");
  const approvalMatrixPath = path.join(home, "approval-matrix.json");
  const rolloutFlagsPath = path.join(home, "rollout-flags.json");
  await fs.mkdir(policyDir, { recursive: true });
  await fs.writeFile(
    path.join(policyDir, "channel-policy.json"),
    JSON.stringify(
      {
        schema_version: 1,
        stage: "topology",
        policy_version: "test-cluster",
        channels: [
          { id: "slack", allowed_action_classes: ["observe", "recommend", "draft", "notify"] },
          {
            id: "telegram",
            approval_surface: true,
            allowed_action_classes: ["send", "mutate", "execute"],
          },
        ],
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(policyDir, "trigger-ranking.json"),
    JSON.stringify(
      {
        schema_version: 1,
        stage: "topology",
        policy_version: "test-cluster",
        signals: [],
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    path.join(policyDir, "persona-routing.json"),
    JSON.stringify(
      {
        schema_version: 1,
        stage: "topology",
        policy_version: "test-cluster",
        personas: [],
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    approvalMatrixPath,
    JSON.stringify(
      {
        schema_version: 1,
        stage: "topology",
        policy_version: "test-policy",
        default_decision: "approve",
        required_systems: ["slack", "gmail", "jira", "notion"],
        required_system_actions: ["read", "draft", "create", "send", "system_change"],
        entries: [
          {
            action_class: "draft",
            decision: "allow",
            approval_route: "none",
            allowed_channels: ["slack", "telegram"],
          },
          {
            action_class: "send",
            decision: "approve",
            approval_route: "telegram_approval",
            allowed_channels: ["telegram"],
          },
          {
            action_class: "mutate",
            decision: options?.allowStructuredCreate ? "allow" : "approve",
            approval_route: options?.allowStructuredCreate ? "none" : "telegram_approval",
            allowed_channels: ["telegram"],
          },
        ],
        system_authority_matrix: [
          {
            id: "slack",
            actions: [
              { id: "draft", action_class: "draft", decision: "allow", approval_route: "none" },
              {
                id: "send",
                action_class: "send",
                decision: "approve",
                approval_route: "telegram_approval",
              },
            ],
          },
          {
            id: "gmail",
            actions: [
              { id: "draft", action_class: "draft", decision: "allow", approval_route: "none" },
              {
                id: "send",
                action_class: "send",
                decision: "approve",
                approval_route: "telegram_approval",
              },
            ],
          },
          {
            id: "jira",
            actions: [
              {
                id: "create",
                action_class: "mutate",
                decision: options?.allowStructuredCreate ? "allow" : "approve",
                approval_route: options?.allowStructuredCreate ? "none" : "telegram_approval",
              },
            ],
          },
          {
            id: "notion",
            actions: [
              {
                id: "create",
                action_class: "mutate",
                decision: options?.allowStructuredCreate ? "allow" : "approve",
                approval_route: options?.allowStructuredCreate ? "none" : "telegram_approval",
              },
            ],
          },
        ],
        source_of_truth: {
          precedence: ["ledger", "execution_state", "external_artifact_links", "raw_source_events"],
          layers: [
            { id: "ledger", rank: 1 },
            { id: "execution_state", rank: 2 },
            { id: "external_artifact_links", rank: 3 },
            { id: "raw_source_events", rank: 4 },
          ],
          systems: [
            {
              id: "slack",
              layer: "raw_source_events",
              reconciliation_mode: "candidate_task_only",
              promote_to_task_truth: false,
            },
            {
              id: "gmail",
              layer: "raw_source_events",
              reconciliation_mode: "candidate_task_only",
              promote_to_task_truth: false,
            },
            {
              id: "jira",
              layer: "external_artifact_links",
              reconciliation_mode: "linked_issue",
              promote_to_task_truth: false,
            },
            {
              id: "notion",
              layer: "external_artifact_links",
              reconciliation_mode: "linked_document",
              promote_to_task_truth: false,
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    rolloutFlagsPath,
    JSON.stringify(
      {
        policy_version: "test",
        lanes: [
          { id: "artifact_adapters", enabled: true },
          { id: "approval_inbox", enabled: true },
          { id: "self_healing", enabled: false },
        ],
      },
      null,
      2,
    ),
  );
  return {
    OPENCLAW_CONTROL_PLANE_DIR: policyDir,
    OPENCLAW_APPROVAL_MATRIX_PATH: approvalMatrixPath,
    OPENCLAW_ROLLOUT_FLAGS_PATH: rolloutFlagsPath,
  };
}

function buildTask(params: {
  id: string;
  sourceKind: "slack" | "gmail" | "jira" | "notion" | "github";
  title: string;
}) {
  const now = "2026-04-09T12:00:00.000Z";
  return {
    id: params.id,
    title: params.title,
    status: "pending" as const,
    dependencies: [],
    acceptanceCriteria: [],
    evidence: [],
    verificationHistory: [],
    canonicalWork: createCanonicalTaskWork(
      {
        source: {
          sourceKind: params.sourceKind,
          signalKind: "mention",
          sourceId: `${params.sourceKind}-1`,
          idempotencyKey: `${params.sourceKind}-delivery-1`,
          title: params.title,
          summary: `${params.title} summary`,
          confidence: { score: 0.9, reason: "test fixture" },
          observedAt: now,
        },
      },
      now,
    ),
    createdAt: now,
    updatedAt: now,
  };
}

describe("task-os artifacts", () => {
  it("keeps Slack and Gmail outputs draft-only", async () => {
    await withTempHome(async (home) => {
      const env = await writeControlPlaneFixture(home);
      Object.assign(process.env, env);
      const priority = {
        taskId: "task-1",
        title: "Reply to launch blocker",
        persona: "chief_of_staff",
        urgency: "high",
        cadence: "daily",
        score: 82,
        signalId: "mention",
        actionClassCap: "draft",
        sourceKind: "slack",
        confidence: { score: 0.9, label: "high" },
        whyNow: "Fresh mention needs a response",
        followUp: "Draft the reply",
        notification: {
          status: "ready",
          lowValue: false,
          key: "k",
          fingerprint: "f",
          dedupeSeconds: 1,
          reason: "ok",
        },
      } as const;

      const drafts = buildDefaultArtifactDrafts({
        task: buildTask({ id: "task-1", sourceKind: "slack", title: "Reply to launch blocker" }),
        priority,
      });
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({ kind: "slack_reply", mode: "draft_only" });
    });
  });

  it("auto-creates Jira and Notion artifacts only when policy and target config allow it", async () => {
    await withTempHome(async (home) => {
      const env = await writeControlPlaneFixture(home, { allowStructuredCreate: true });
      Object.assign(process.env, env);
      vi.resetModules();
      const storeModule = await import("./task-os-store.js");
      const storePath = storeModule.resolveTaskOsStorePath();
      const task = await storeModule.createTask({
        id: "task-2",
        title: "Track rollout work",
        canonicalWork: {
          source: {
            sourceKind: "github",
            signalKind: "review_requested",
            sourceId: "openclaw/openclaw#42",
            idempotencyKey: "github-42",
            title: "Track rollout work",
            summary: "Track rollout work summary",
            confidence: { score: 0.92, reason: "review request" },
            observedAt: "2026-04-09T12:00:00.000Z",
          },
        },
      });
      const priority = {
        taskId: task.id,
        title: task.title,
        persona: "cto",
        urgency: "high",
        cadence: "daily",
        score: 88,
        signalId: "goal_deadline",
        actionClassCap: "draft",
        sourceKind: "github",
        confidence: { score: 0.92, label: "high" },
        whyNow: "Due within 24 hours",
        followUp: "Draft the implementation plan",
        notification: {
          status: "ready",
          lowValue: false,
          key: "k",
          fingerprint: "f",
          dedupeSeconds: 1,
          reason: "ok",
        },
      } as const;

      const [jiraDraft, notionDraft] = buildDefaultArtifactDrafts({
        task,
        priority,
        jiraConfig: { projectKey: "OPS", issueType: "Task" },
        notionConfig: { databaseId: "299c0f4d-d8c8-8080-9426-e0561bf18454" },
      });

      expect(jiraDraft.mode).toBe("auto_create");
      expect(notionDraft.mode).toBe("auto_create");

      const fetchMock = vi
        .fn(
          async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
            new Response(),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ key: "OPS-500" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: "page-500", url: "https://www.notion.so/page-500" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );

      const jiraResult = await applyStructuredArtifact({
        task,
        artifact: jiraDraft,
        storePath,
        jiraConfig: {
          baseUrl: "https://makestar-product.atlassian.net",
          email: "ziho@example.com",
          apiToken: "token",
          projectKey: "OPS",
          issueType: "Task",
        },
        fetchImpl: fetchMock,
      });
      const notionResult = await applyStructuredArtifact({
        task,
        artifact: notionDraft,
        storePath,
        notionConfig: {
          apiToken: "ntn_token",
          databaseId: "299c0f4d-d8c8-8080-9426-e0561bf18454",
        },
        fetchImpl: fetchMock,
      });

      expect(jiraResult).toMatchObject({ status: "created", externalId: "OPS-500" });
      expect(notionResult).toMatchObject({ status: "created", externalId: "page-500" });

      const reloaded = await storeModule.loadTaskOsStore();
      const updatedTask = reloaded.tasks.find((entry) => entry.id === task.id);
      expect(updatedTask?.evidence.some((entry) => entry.kind === "artifact_mutation")).toBe(true);
      expect(
        updatedTask?.canonicalWork?.externalLinks.some((entry) => entry.system === "jira"),
      ).toBe(true);
      expect(
        updatedTask?.canonicalWork?.externalLinks.some((entry) => entry.system === "notion"),
      ).toBe(true);
    });
  });
});
