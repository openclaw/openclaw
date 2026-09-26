import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConfigRuntimeEnv,
  createConfigRuntimeEnvBase,
} from "../../config/config-env-vars.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import * as stateLease from "../../state/openclaw-state-lease.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withMockedPlatform } from "../../test-utils/vitest-spies.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { createSkillProposalEvent } from "./plugin-hooks.js";
import * as proposalGeneration from "./proposal-generation.js";
import {
  listSkillProposalEvents,
  listSkillProposals,
  inspectSkillProposal,
  proposeCreateSkill,
  proposeUpdateSkill,
  quarantineSkillProposal,
  rejectSkillProposal,
  reviseSkillProposal,
} from "./service.js";
import { createSkillProposalRollback } from "./service.test-support.js";
import { captureSkillWorkshopStoreOptions } from "./store-client.js";
import { parseSkillProposalEvaluation } from "./store-record.js";
import { writeSkillProposalRollback } from "./store-rollback.js";
import { appendSkillProposalEvent } from "./store-sqlite-event.js";
import {
  commitPendingSkillProposalTransition,
  readCommittedSkillProposalTransition,
} from "./store-transition.js";
import {
  createSkillProposalId,
  hashSkillProposalContent,
  readSkillProposal,
  readSkillProposalManifest,
  readSkillProposalRecord,
  updateSkillProposalRecord,
  writeSkillProposal,
} from "./store.js";

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
  it("inspects terminal generations without write leases and rechecks file integrity", async () => {
    const options = {
      workspaceDir: testState.stateDir,
      config: workshopConfig,
      agentId: "main",
      env: testState.env,
    };
    const proposal = await proposeCreateSkill({
      ...options,
      name: "Terminal Inspection",
      description: "Read retained history without contending with active proposal writers",
      content: "# Terminal Inspection\n\nRetained instructions.\n",
      supportFiles: [{ path: "references/guide.md", content: "Retained supporting material.\n" }],
    });
    await rejectSkillProposal({
      ...options,
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });
    const leases = vi.spyOn(stateLease, "withOpenClawStateLeaseAsync");
    try {
      for (let index = 0; index < 20; index++) {
        await expect(inspectSkillProposal(proposal.record.id, options)).resolves.toMatchObject({
          record: { status: "rejected" },
          revisionHash: proposal.revisionHash,
          content: proposal.content,
          supportFiles: [
            { path: "references/guide.md", content: "Retained supporting material.\n" },
          ],
        });
      }
      expect(leases.mock.calls.length).toBe(0);
      await expect(
        inspectSkillProposal(proposal.record.id, { ...options, agentId: "other" }),
      ).resolves.toBeNull();
      await fs.writeFile(
        testState.statePath(
          proposalGeneration.proposalBundleRelativePath(proposal.record, "references/guide.md"),
        ),
        "Changed without updating metadata.\n",
      );
      await expect(inspectSkillProposal(proposal.record.id, options)).rejects.toThrow(
        "Proposal support file changed without updating metadata",
      );
    } finally {
      leases.mockRestore();
    }
  });

  it.each([
    { platform: "win32", stateKey: "openclaw_state_dir" },
    { platform: "linux", stateKey: "OPENCLAW_STATE_DIR" },
  ] as const)(
    "preserves $platform environment semantics when capturing proposal storage",
    (fixture) => {
      withMockedPlatform(fixture.platform, () => {
        const config = { env: { vars: { WORKSHOP_CAPTURE_VALUE: "configured" } } };
        const rawEnv: NodeJS.ProcessEnv = {
          ...testState.env,
          HOME: testState.path("fallback-home"),
          USERPROFILE: testState.path("fallback-home"),
        };
        delete rawEnv.OPENCLAW_STATE_DIR;
        rawEnv[fixture.stateKey] = testState.stateDir;
        const env = createConfigRuntimeEnv(config, rawEnv);
        expect(proposalGeneration.resolveSkillWorkshopStateDir({ env })).toBe(testState.stateDir);

        const captured = captureSkillWorkshopStoreOptions({ env, config, agentId: "main" });
        env[fixture.stateKey] = testState.path("replaced-state");

        expect.soft(captured.stateDir).toBe(testState.stateDir);
        expect.soft(captured.env.OPENCLAW_STATE_DIR).toBe(testState.stateDir);
        expect
          .soft(captured.execution.context.environment.OPENCLAW_STATE_DIR)
          .toBe(testState.stateDir);
        expect
          .soft(captured.execution.context.admission.databasePath)
          .toBe(path.join(testState.stateDir, "state", "openclaw.sqlite"));
        expect
          .soft(createConfigRuntimeEnvBase(config, captured.env).WORKSHOP_CAPTURE_VALUE)
          .toBeUndefined();
        expect(env.WORKSHOP_CAPTURE_VALUE).toBe("configured");
      });
    },
  );

  it("retains proposal inputs and storage routing across generation staging without caller SQL", async () => {
    const seed = await proposeCreateSkill({
      workspaceDir: testState.stateDir,
      config: workshopConfig,
      agentId: "main",
      name: "Captured Proposal",
      description: "Keep staged files and committed metadata on one captured store",
      content: "# Captured Proposal\n\nOriginal instructions.\n",
      env: testState.env,
    });
    const env = { ...testState.env };
    const redirectedRoot = testState.path("redirected-workshop-state");
    await fs.mkdir(redirectedRoot);
    const record = {
      ...structuredClone(seed.record),
      id: createSkillProposalId("captured-write"),
      draftFile: proposalGeneration.createSkillProposalGenerationDraftFile(),
    };
    const payload = { title: "Original event" };
    const event = createSkillProposalEvent({ record, type: "created", payload });
    const input = {
      record,
      content: seed.content,
      ownerAgentId: "main",
      maxPending: 10,
      event,
      store: { env },
    };
    const expected = structuredClone({ record, content: input.content, event });
    const staged = createDeferredCore();
    const release = createDeferredCore();
    const stage = proposalGeneration.stageSkillProposalGeneration;
    const staging = vi
      .spyOn(proposalGeneration, "stageSkillProposalGeneration")
      .mockImplementation(async (params) => {
        await stage(params);
        staged.resolve();
        await release.promise;
      });
    const sql = observeMainThreadSql();
    const writing = writeSkillProposal(input);
    let committed: Awaited<ReturnType<typeof writeSkillProposal>>;
    try {
      await Promise.race([
        staged.promise,
        writing.then(() => {
          throw new Error("Proposal write completed before staged generation was released");
        }),
      ]);
      record.title = "Changed after staging";
      input.content = "# Changed instructions\n";
      record.draftHash = hashSkillProposalContent(input.content);
      event.revisionHash = "f".repeat(64);
      payload.title = "Changed event";
      env.OPENCLAW_STATE_DIR = redirectedRoot;
      release.resolve();
      committed = await writing;
      sql.expectIdle();
    } finally {
      release.resolve();
      await writing.catch(() => undefined);
      sql.restore();
      staging.mockRestore();
    }

    expect(committed).toEqual({ ...expected.event, sequence: expect.any(Number) });
    const { db } = openOpenClawStateDatabase({ env: testState.env });
    expect(
      db
        .prepare("SELECT record_json FROM skill_workshop_proposals WHERE proposal_id = ?")
        .get(expected.record.id),
    ).toEqual({ record_json: JSON.stringify(expected.record) });
    expect(
      (
        await listSkillProposalEvents({
          config: workshopConfig,
          env: testState.env,
          proposalId: expected.record.id,
        })
      ).events,
    ).toEqual([committed]);
    await expect(
      fs.readFile(
        path.join(
          testState.stateDir,
          proposalGeneration.proposalBundleRelativePath(expected.record, "PROPOSAL.md"),
        ),
        "utf8",
      ),
    ).resolves.toBe(expected.content);
    await expect(
      fs.access(path.join(redirectedRoot, "state", "openclaw.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains the requested agent scope across asynchronous proposal lookups", async () => {
    const proposal = await proposeCreateSkill({
      workspaceDir: testState.stateDir,
      config: workshopConfig,
      agentId: "main",
      name: "Captured Lookup Scope",
      description: "Keep another agent's proposal outside the requested scope",
      content: "# Captured Lookup Scope\n",
      env: testState.env,
    });
    const store = { config: workshopConfig, env: testState.env };
    const readOptions = { config: workshopConfig, reconcile: false };
    const bundleScope = { agentId: "other" };
    const bundle = readSkillProposal(proposal.record.id, store, bundleScope, readOptions);
    bundleScope.agentId = "main";
    const recordScope = { agentId: "other" };
    const record = readSkillProposalRecord(proposal.record.id, store, recordScope, readOptions);
    recordScope.agentId = "main";
    const manifestScope = { agentId: "other" };
    const manifest = readSkillProposalManifest(store, manifestScope);
    manifestScope.agentId = "main";
    const [bundleResult, recordResult, manifestResult] = await Promise.all([
      bundle,
      record,
      manifest,
    ]);

    expect.soft(bundleResult).toBeNull();
    expect.soft(recordResult).toBeNull();
    expect.soft(manifestResult.proposals).toEqual([]);
  });

  it.each([
    ["record", readSkillProposalRecord],
    ["bundle", readSkillProposal],
  ] as const)("retains recovery controls across an asynchronous %s read", async (kind, read) => {
    const store = { config: workshopConfig, agentId: "main", env: testState.env };
    const scope = { agentId: "main" };
    const seedInterruptedApply = async (name: string) => {
      const proposal = await proposeCreateSkill({
        ...store,
        workspaceDir: testState.stateDir,
        name,
        description: "Recover a completed target write using the original read controls",
        content: `# ${name}\n\nWritten before the status commit.\n`,
      });
      await writeSkillProposalRollback({
        proposalId: proposal.record.id,
        rollback: createSkillProposalRollback({
          proposalId: proposal.record.id,
          targetSkillFile: proposal.record.target.skillFile,
          action: "create",
        }),
        store,
      });
      await fs.mkdir(proposal.record.target.skillDir, { recursive: true });
      await fs.writeFile(
        proposal.record.target.skillFile,
        stripProposalFrontmatterForSkill(proposal.content),
        "utf8",
      );
      return proposal;
    };

    const deferred = await seedInterruptedApply(`Deferred ${kind} Recovery`);
    const readOptions = { config: workshopConfig, reconcile: false };
    const deferredRead = read(deferred.record.id, store, scope, readOptions);
    readOptions.reconcile = true;
    await expect
      .soft(deferredRead)
      .resolves.toMatchObject(
        kind === "record" ? { status: "pending" } : { record: { status: "pending" } },
      );
    await expect
      .soft(
        readSkillProposalRecord(deferred.record.id, store, scope, {
          config: workshopConfig,
          reconcile: false,
        }),
      )
      .resolves.toMatchObject({ status: "pending" });

    const recoverable = await seedInterruptedApply(`Captured ${kind} Recovery`);
    const recoveryOptions: Parameters<typeof readSkillProposalRecord>[3] = {
      config: workshopConfig,
      reconcile: true,
    };
    const recoveryRead = read(recoverable.record.id, store, scope, recoveryOptions);
    recoveryOptions.config = {
      agents: { list: [{ id: "main", agentDir: testState.path("redirected-agent") }] },
    };
    await expect
      .soft(recoveryRead)
      .resolves.toMatchObject(
        kind === "record" ? { status: "applied" } : { record: { status: "applied" } },
      );
    await expect
      .soft(
        readSkillProposalRecord(recoverable.record.id, store, scope, {
          config: workshopConfig,
          reconcile: false,
        }),
      )
      .resolves.toMatchObject({ status: "applied" });
    const { events } = await listSkillProposalEvents({
      ...store,
      proposalId: recoverable.record.id,
    });
    expect
      .soft(events.filter((event) => event.type === "applied"))
      .toEqual([expect.objectContaining({ payload: { recovered: true } })]);
  });

  it("persists the original actor through asynchronous proposal lifecycle operations", async () => {
    const options = {
      workspaceDir: testState.stateDir,
      config: workshopConfig,
      agentId: "main",
      env: testState.env,
    };
    const createActor = { type: "agent" as const, id: "create-author" };
    const creating = proposeCreateSkill({
      ...options,
      name: "Captured Event Actors",
      description: "Keep audit attribution fixed at each operation's entry",
      content: "# Captured Event Actors\n\nOriginal instructions.\n",
      eventActor: createActor,
    });
    createActor.id = "changed-create-author";
    const created = await creating;

    const reviseActor = { type: "agent" as const, id: "revision-author" };
    const revising = reviseSkillProposal({
      ...options,
      proposalId: created.record.id,
      expectedRevisionHash: created.revisionHash,
      content: "# Captured Event Actors\n\nRevised instructions.\n",
      eventActor: reviseActor,
    });
    reviseActor.id = "changed-revision-author";
    const revised = await revising;

    const rejectActor = { type: "agent" as const, id: "reject-author" };
    const rejecting = rejectSkillProposal({
      ...options,
      proposalId: revised.record.id,
      expectedRevisionHash: revised.revisionHash,
      eventActor: rejectActor,
    });
    rejectActor.id = "changed-reject-author";
    await rejecting;

    await fs.mkdir(revised.record.target.skillDir, { recursive: true });
    await fs.writeFile(
      revised.record.target.skillFile,
      stripProposalFrontmatterForSkill(revised.content),
      "utf8",
    );
    const updateActor = { type: "agent" as const, id: "update-author" };
    const updating = proposeUpdateSkill({
      ...options,
      skillName: revised.record.target.skillKey,
      content: "# Captured Event Actors\n\nUpdated instructions.\n",
      eventActor: updateActor,
    });
    updateActor.id = "changed-update-author";
    const updated = await updating;

    const quarantineActor = { type: "agent" as const, id: "quarantine-author" };
    const quarantining = quarantineSkillProposal({
      ...options,
      proposalId: updated.record.id,
      expectedRevisionHash: updated.revisionHash,
      eventActor: quarantineActor,
    });
    quarantineActor.id = "changed-quarantine-author";
    await quarantining;

    const { events: createEvents } = await listSkillProposalEvents({
      ...options,
      proposalId: created.record.id,
    });
    const { events: updateEvents } = await listSkillProposalEvents({
      ...options,
      proposalId: updated.record.id,
    });
    expect
      .soft(createEvents.map((event) => event.type))
      .toEqual(["created", "revised", "rejected"]);
    expect.soft(updateEvents.map((event) => event.type)).toEqual(["created", "quarantined"]);
    for (const [event, actorId, revisionHash] of [
      [createEvents[0], "create-author", created.revisionHash],
      [createEvents[1], "revision-author", revised.revisionHash],
      [createEvents[2], "reject-author", revised.revisionHash],
      [updateEvents[0], "update-author", updated.revisionHash],
      [updateEvents[1], "quarantine-author", updated.revisionHash],
    ] as const) {
      expect.soft(event, actorId).toMatchObject({
        actor: { type: "agent", id: actorId },
        revisionHash,
      });
    }
  });

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

    const committed = await commitPendingSkillProposalTransition({
      expected: proposal.record,
      record: applied,
      event,
      operationLabel: "skill-workshop.test.commit",
    });
    expect(committed).toMatchObject({ state: "committed", event: { eventId: event.eventId } });
    expect(await readCommittedSkillProposalTransition({ record: applied, event })).toEqual(
      committed,
    );
    expect(
      await commitPendingSkillProposalTransition({
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
