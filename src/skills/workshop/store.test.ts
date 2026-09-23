import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSkillProposalEvent } from "./plugin-hooks.js";
import { listSkillProposalEvents, listSkillProposals, proposeCreateSkill } from "./service.js";
import { parseSkillProposalEvaluation } from "./store-record.js";
import { appendSkillProposalEvent } from "./store-sqlite-event.js";
import {
  commitPendingSkillProposalTransition,
  readCommittedSkillProposalTransition,
} from "./store-sqlite-transition.js";
import { updateSkillProposalRecord } from "./store.js";

let testState: OpenClawTestState;
const workshopConfig = {};

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workshop-store-",
  });
});

afterEach(async () => {
  await testState.cleanup();
});

describe("Skill Workshop SQLite store", () => {
  it("preserves event ownership, proposal filters, exclusive cursors, and row limits", async () => {
    const create = (name: string) =>
      proposeCreateSkill({
        workspaceDir: testState.stateDir,
        config: workshopConfig,
        agentId: "main",
        name,
        description: "Replay filtering fixture",
        content: `# ${name}\n`,
      });
    const primary = await create("Primary Events");
    const sibling = await create("Sibling Events");
    const foreign = await create("Foreign Events");
    const ownerless = await create("Ownerless Events");
    const { db: fixtureDatabase } = openOpenClawStateDatabase();
    const assignOwner = fixtureDatabase.prepare(
      "UPDATE skill_workshop_proposals SET owner_agent_id = ? WHERE proposal_id = ?",
    );
    assignOwner.run("other", foreign.record.id);
    assignOwner.run(null, ownerless.record.id);
    const revision = runOpenClawStateWriteTransaction(({ db }) =>
      appendSkillProposalEvent(
        db,
        createSkillProposalEvent({ record: primary.record, type: "revised" }),
      ),
    );
    const query = { config: workshopConfig, agentId: "main", proposalId: primary.record.id };
    const first = await listSkillProposalEvents({ ...query, limit: 0 });
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.type).toBe("created");
    expect(first.nextSequence).toBe(first.events[0]?.sequence);
    const next = await listSkillProposalEvents({ ...query, afterSequence: first.nextSequence });
    expect(next).toEqual({ events: [revision] });
    expect(
      (await listSkillProposalEvents({ config: workshopConfig, agentId: "main" })).events.map(
        (event) => event.proposalId,
      ),
    ).toEqual([primary.record.id, sibling.record.id, primary.record.id]);
    expect(
      (await listSkillProposalEvents({ config: workshopConfig })).events.map(
        (event) => event.proposalId,
      ),
    ).toEqual([primary.record.id, sibling.record.id, foreign.record.id, primary.record.id]);
    runOpenClawStateWriteTransaction(({ db }) => {
      for (let index = 0; index < 205; index += 1) {
        appendSkillProposalEvent(
          db,
          createSkillProposalEvent({ record: primary.record, type: "revised" }),
        );
      }
    });
    const capped = await listSkillProposalEvents({ ...query, limit: 1_000 });
    expect(capped.events).toHaveLength(200);
    expect(capped.nextSequence).toBe(capped.events.at(-1)?.sequence);
    const remainder = await listSkillProposalEvents({
      ...query,
      afterSequence: capped.nextSequence,
    });
    expect(remainder.events).toHaveLength(7);
    expect(remainder.nextSequence).toBeUndefined();
  });

  it("commits a pending transition once and rejects stale record facts", async () => {
    const proposal = await proposeCreateSkill({
      workspaceDir: testState.stateDir,
      config: workshopConfig,
      agentId: "main",
      name: "Transition Compare And Swap",
      description: "Bind state transitions to authoritative proposal facts",
      content: "# Transition Compare And Swap\n",
    });
    const applied = {
      ...proposal.record,
      status: "applied" as const,
      updatedAt: "2026-07-29T00:00:00.000Z",
      appliedAt: "2026-07-29T00:00:00.000Z",
    };
    const event = createSkillProposalEvent({ record: applied, type: "applied" });

    const committed = commitPendingSkillProposalTransition({
      expected: proposal.record,
      record: applied,
      event,
      operationLabel: "skill-workshop.test.commit",
    });
    expect(committed).toMatchObject({ state: "committed", event: { eventId: event.eventId } });
    expect(readCommittedSkillProposalTransition({ record: applied, event })).toEqual(committed);
    expect(
      commitPendingSkillProposalTransition({
        expected: proposal.record,
        record: applied,
        event,
        operationLabel: "skill-workshop.test.conflict",
      }),
    ).toMatchObject({ state: "conflict", current: { status: "applied" } });
  });

  it("lazily ensures additive tables without changing the schema version", async () => {
    const databasePath = openOpenClawStateDatabase().path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const existing = new DatabaseSync(databasePath);
    existing.exec(`
      DROP TABLE skill_workshop_proposal_events;
      DROP TABLE skill_workshop_proposal_rollbacks;
      DROP TABLE skill_workshop_proposals;
      DROP TABLE skill_workshop_collection_reviews;
    `);
    existing.close();

    const reopened = openOpenClawStateDatabase();
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("skill_workshop_proposals"),
    ).toBeUndefined();
    await expect(
      listSkillProposals({ config: workshopConfig, agentId: "main" }),
    ).resolves.toMatchObject({ proposals: [] });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("skill_workshop_proposals"),
    ).toEqual({ name: "skill_workshop_proposals" });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("skill_workshop_proposal_events"),
    ).toEqual({ name: "skill_workshop_proposal_events" });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("skill_workshop_collection_reviews"),
    ).toEqual({ name: "skill_workshop_collection_reviews" });
    expect(
      reopened.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?")
        .get("idx_skill_workshop_collection_reviews_workspace_time"),
    ).toBeUndefined();
    expect(
      reopened.db
        .prepare(
          "SELECT name, type, \"notnull\" FROM pragma_table_info('skill_workshop_proposals') WHERE name = ?",
        )
        .get("claim_released_time"),
    ).toBeUndefined();
    expect(reopened.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  });

  it("keeps arbitrary payload keys disjoint from durable evaluations", async () => {
    const proposal = await proposeCreateSkill({
      workspaceDir: testState.stateDir,
      config: workshopConfig,
      agentId: "main",
      name: "Event Envelope",
      description: "Exercise event payload encoding",
      content: "# Event Envelope\n",
    });
    const evaluation = {
      id: "evaluation-envelope",
      proposedVersion: proposal.record.proposedVersion,
      revisionHash: proposal.revisionHash,
      trigger: "manual" as const,
      startedAt: "2026-07-29T00:00:00.000Z",
      completedAt: "2026-07-29T00:00:01.000Z",
      outcomes: [],
    };
    await updateSkillProposalRecord({
      record: proposal.record,
      event: createSkillProposalEvent({
        record: proposal.record,
        type: "evaluation_completed",
        payload: { evaluation: "manual", outcomeCount: 0 },
        evaluation,
      }),
    });

    expect(
      (
        await listSkillProposalEvents({
          config: workshopConfig,
          proposalId: proposal.record.id,
        })
      ).events[1],
    ).toMatchObject({
      payload: { evaluation: "manual", outcomeCount: 0 },
      evaluation: { id: evaluation.id },
    });
  });

  it("rejects non-string evaluation tree hashes", () => {
    expect(
      parseSkillProposalEvaluation({
        id: "evaluation-invalid-tree-hash",
        proposedVersion: "v1",
        revisionHash: "a".repeat(64),
        trigger: "manual",
        startedAt: "2026-07-29T00:00:00.000Z",
        completedAt: "2026-07-29T00:00:01.000Z",
        targetTreeSha256: ["b".repeat(64)],
        outcomes: [],
      }),
    ).toBeNull();
  });

  it("paginates durable evaluations before the response byte budget", async () => {
    const proposal = await proposeCreateSkill({
      workspaceDir: testState.stateDir,
      agentId: "main",
      config: workshopConfig,
      name: "Event Page Budget",
      description: "Bound replay response size",
      content: "# Event Page Budget\n",
    });
    const findings = Array.from({ length: 80 }, (_, index) => ({
      ruleId: `large-${index}`,
      severity: "info" as const,
      message: "x".repeat(4_000),
    }));
    for (let index = 0; index < 7; index += 1) {
      const evaluation = {
        id: `evaluation-page-${index}`,
        proposedVersion: proposal.record.proposedVersion,
        revisionHash: proposal.revisionHash,
        trigger: "manual" as const,
        startedAt: "2026-07-29T00:00:00.000Z",
        completedAt: "2026-07-29T00:00:01.000Z",
        outcomes: [
          {
            evaluatorId: "page-budget",
            pluginId: "store-tests",
            status: "completed" as const,
            result: { findings },
          },
        ],
      };
      await updateSkillProposalRecord({
        record: proposal.record,
        event: createSkillProposalEvent({
          record: proposal.record,
          type: "evaluation_completed",
          evaluation,
        }),
      });
    }

    const firstPage = await listSkillProposalEvents({
      config: workshopConfig,
      proposalId: proposal.record.id,
      limit: 200,
    });
    expect(firstPage.events.length).toBeLessThan(8);
    expect(firstPage.nextSequence).toBeDefined();
    expect(Buffer.byteLength(JSON.stringify(firstPage), "utf8")).toBeLessThanOrEqual(
      2 * 1024 * 1024 + 1_024,
    );
    const secondPage = await listSkillProposalEvents({
      config: workshopConfig,
      proposalId: proposal.record.id,
      afterSequence: firstPage.nextSequence,
      limit: 200,
    });
    expect(secondPage.events.length).toBeGreaterThan(0);
  });

  it("fails replay explicitly for oversized stored event data", async () => {
    const proposal = await proposeCreateSkill({
      workspaceDir: testState.stateDir,
      agentId: "main",
      config: workshopConfig,
      name: "Oversized Stored Event",
      description: "Reject silent audit data loss",
      content: "# Oversized Stored Event\n",
    });
    openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE skill_workshop_proposal_events SET payload_json = ? WHERE proposal_id = ?",
      )
      .run("x".repeat(600 * 1024), proposal.record.id);

    await expect(
      listSkillProposalEvents({
        config: workshopConfig,
        proposalId: proposal.record.id,
      }),
    ).rejects.toThrow(/Stored Skill Workshop event .* cannot be replayed safely/);
  });
});
