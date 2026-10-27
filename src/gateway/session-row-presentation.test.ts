import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { SESSION_ROWS_DELTA_PREFIX } from "../../packages/gateway-protocol/src/session-row-fields.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import {
  claimAgentRunContext,
  getAgentRunLifecycleGeneration,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import {
  rpcSourceTesting,
  setRpcSourceIdentityForTest,
  setRpcSourceTerminalProjectionForTest,
} from "../sessions/session-lifecycle-admission.test-support.js";
import {
  readResidentUserProfileIdentity,
  prepareUserProfileCatalog,
} from "../state/user-profile-list.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createExpectedProfileBinding,
  ExpectedProfileMismatchError,
  prepareGatewayRecipientProfile,
} from "./expected-profile.js";
import { serializeGatewayFrame } from "./serialized-json.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { createVisibleActiveSessionRunProjector } from "./server-methods/session-active-runs.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createSessionRowEventPeer } from "./session-row-event.test-support.js";
import { captureSessionRowGeneration } from "./session-row-identity.js";
import * as preparedRead from "./session-row-prepared-read.js";
import {
  prepareProjectedSessionPresentation,
  prepareSessionRowPublication,
  shareSidebarSessionRows,
} from "./session-row-presentation.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import {
  createTestProjection,
  holdSubagentExecution,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";
import { serializeSessionRow, sessionRowEncodingBytes } from "./session-row-serialization.js";
import * as sharingPolicy from "./session-sharing-policy.js";
import { canReceiveSessionEvent } from "./session-sharing.js";
import { rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import { listProjectedSessions } from "./session-utils-list.js";
import { createRpcSourceForTest } from "./test-helpers.rpc-source.js";

afterEach(() => vi.restoreAllMocks());

function profileClient(profileId: string) {
  const client = sharingPolicyClient({ user: profileId });
  prepareGatewayRecipientProfile(client);
  return client;
}

it("encodes only the wire representation of retained sidebar rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const keys = ["agent:main:encoding-a", "agent:main:encoding-b"];
    for (const key of keys) {
      seedRow(key, { sessionId: key, updatedAt: 1, label: "Shared sidebar label" });
    }
    using projection = await createTestProjection({ cfg: {}, modelCatalog: [] });
    await projection.ensureMaterialized();
    const presenter = prepareSessionRowPublication(projection, Date.now())().getPresentation();
    const rows = keys.map(
      (key) => presenter.snapshot({ agentId: "main", key }, { rowMode: "sidebar" }).row!,
    );
    const shared = shareSidebarSessionRows(rows);
    expect(shared.sharedFacts?.length).toBeGreaterThan(0);
    expect(rows.map(sessionRowEncodingBytes)).toEqual([0, 0]);
    expect(shared.sessions.map(sessionRowEncodingBytes).every((bytes) => bytes > 0)).toBe(true);
    const generation = captureSessionRowGeneration(rows);
    seedRow(keys[0]!, { sessionId: keys[0]!, updatedAt: 2, label: "Changed sidebar label" });
    await projection.ensureMaterialized();
    const nextPresenter = prepareSessionRowPublication(projection, Date.now())().getPresentation();
    const nextRows = keys.map(
      (key) => nextPresenter.snapshot({ agentId: "main", key }, { rowMode: "sidebar" }).row!,
    );
    using deltaStringify = vi.spyOn(JSON, "stringify");
    const readDelta = () =>
      shareSidebarSessionRows(nextRows, `${SESSION_ROWS_DELTA_PREFIX}${generation.revision}`, [
        generation,
      ]);
    const delta = readDelta();
    for (let viewer = 1; viewer < 66; viewer++) {
      readDelta();
    }
    expect(deltaStringify.mock.calls.filter(([row]) => row === nextRows[0])).toHaveLength(1);
    deltaStringify.mockRestore();
    expect(delta.sessions).toHaveLength(1);
    expect(delta.sessions[0]?.label).toBe("Changed sidebar label");
    expect(sessionRowEncodingBytes(nextRows[0]!)).toBe(JSON.stringify(nextRows[0]).length * 2);
    expect(sessionRowEncodingBytes(nextRows[1]!)).toBe(0);
    for (const payload of [shared, delta]) {
      const frame = { type: "res", id: "rows", ok: true, payload };
      expect(serializeGatewayFrame(frame).toString()).toBe(JSON.stringify(frame));
    }
    // A later single-row event still prepares byte-identical JSON once and reuses it.
    const expected = JSON.stringify(rows[0]);
    using stringify = vi.spyOn(JSON, "stringify");
    expect(serializeSessionRow(rows[0]!)).toBe(expected);
    expect(serializeSessionRow(rows[0]!)).toBe(expected);
    expect(stringify).toHaveBeenCalledTimes(1);
  });
});

it("does not derive discarded diagnostics while interleaving row modes and viewers", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    const owner = ensureProfileForEmail("owner@row-mode.test");
    const guest = ensureProfileForEmail("guest@row-mode.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const clients = [owner, guest].map((profile) => profileClient(profile.id));
    for (const visibility of ["shared", "draft"] as const) {
      seedRow(`agent:main:${visibility}`, {
        sessionId: visibility,
        updatedAt: 1,
        visibility,
        createdActor: { type: "human", source: "profile", id: owner.id },
      });
    }
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    const diagnostics = vi.spyOn(sharingPolicy, "authorizeSessionAgentRun");
    const summaryEligibility = vi.spyOn(sharingPolicy, "authorizeIncognitoSessionTarget");
    for (const rowMode of ["sidebar", "compact", "dashboard", undefined, "sidebar"] as const) {
      for (const [index, client] of clients.entries()) {
        diagnostics.mockClear();
        summaryEligibility.mockClear();
        const result = await listProjectedSessions({
          projection,
          client,
          opts: { rowMode, includeActivitySummary: true },
          acceptsSerializedJson: true,
        });
        expect(result.count).toBe(index === 0 ? 2 : 1);
        const row = result.sessions.find((candidate) => candidate.key === "agent:main:shared")!;
        if (rowMode === "sidebar" || rowMode === "dashboard") {
          expect(diagnostics).not.toHaveBeenCalled();
          expect(summaryEligibility).not.toHaveBeenCalled();
          expect(row.activitySummary).toBeUndefined();
          expect(row.sendDisabledReason).toBeUndefined();
        } else {
          expect(diagnostics).toHaveBeenCalled();
          expect(summaryEligibility).toHaveBeenCalled();
          expect(row.activitySummary?.canEnsure).toBe(index === 0);
          expect(row.sendDisabledReason).toBe(
            index === 0 ? null : "session is shared for this connection",
          );
        }
      }
    }
    for (const role of ["write", "view"] as const) {
      setUserProfileRole(guest.id, role);
      prepareGatewayRecipientProfile(clients[1]!);
      for (const includeActivitySummary of [true, false]) {
        summaryEligibility.mockClear();
        const result = await listProjectedSessions({
          projection,
          client: clients[1],
          opts: { rowMode: "compact", includeActivitySummary },
        });
        const row = result.sessions.find((candidate) => candidate.key === "agent:main:shared")!;
        if (includeActivitySummary) {
          expect(row.activitySummary?.canEnsure).toBe(role === "write");
        } else {
          expect(row.activitySummary).toBeUndefined();
          expect(summaryEligibility).not.toHaveBeenCalled();
        }
      }
    }
    setUserProfileRole(guest.id, "none");
    prepareGatewayRecipientProfile(clients[1]!);
    expect(
      (
        await listProjectedSessions({
          projection,
          client: clients[1],
          opts: { rowMode: "sidebar" },
        })
      ).sessions,
    ).toEqual([]);
  });
});

it("separates promoted navigation activity from live controller activity", async () => {
  using clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(1_800_000_000_000);
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const parent = "agent:main:dashboard:former-parent";
    const child = "agent:main:dashboard:promoted";
    const requester = "agent:main:dashboard:requester";
    const worker = "agent:main:subagent:promotion-worker";
    const childEntry = {
      sessionId: child,
      updatedAt: Date.now(),
      status: "done" as const,
      parentSessionKey: parent,
    };
    for (const key of [parent, requester]) {
      seedRow(key, { sessionId: key, updatedAt: Date.now(), status: "done" });
    }
    seedRow(child, childEntry);
    seedRow(worker, { sessionId: worker, updatedAt: Date.now(), spawnedBy: child });
    const workerRun = createSubagentRunRecord({
      runId: "promotion-worker",
      childSessionKey: worker,
      requesterSessionKey: child,
      startedAt: Date.now(),
    });
    const controllerRun = createSubagentRunRecord({
      runId: "promotion-controller",
      childSessionKey: child,
      requesterSessionKey: requester,
      controllerSessionKey: parent,
      startedAt: Date.now(),
    });
    using workerExecution = holdSubagentExecution(workerRun.runId, worker);
    subagentRuns.set(workerRun.runId, workerRun);
    subagentRuns.commitOwnership(workerRun);
    try {
      using projection = await createTestProjection({ cfg: {}, modelCatalog: [] });
      const read = async () =>
        new Map(
          (await listProjectedSessions({ projection, opts: {} })).sessions.map((row) => [
            row.key,
            row,
          ]),
        );
      expect((await read()).get(parent)).toMatchObject({
        childSessions: [child],
        hasActiveSubagentRun: true,
      });
      seedRow(child, { ...childEntry, sidebarRoot: true });
      for (let repeat = 0; repeat < 2; repeat++) {
        const rows = await read();
        expect(rows.get(child)?.hasActiveSubagentRun).toBe(true);
        expect(rows.get(parent)?.hasActiveSubagentRun).not.toBe(true);
        expect(rows.get(parent)?.childSessions).toEqual([child]);
      }
      using controllerExecution = holdSubagentExecution(controllerRun.runId, child);
      subagentRuns.set(controllerRun.runId, controllerRun);
      subagentRuns.commitOwnership(controllerRun);
      for (let repeat = 0; repeat < 2; repeat++) {
        expect((await read()).get(parent)?.hasActiveSubagentRun).toBe(true);
      }
      controllerExecution[Symbol.dispose]();
      subagentRuns.delete(controllerRun.runId);
      publishSubagentRunChanges([child, parent, requester], [controllerRun.runId]);
      for (let repeat = 0; repeat < 2; repeat++) {
        expect((await read()).get(parent)?.hasActiveSubagentRun).not.toBe(true);
      }
      seedRow(child, childEntry);
      expect((await read()).get(parent)?.hasActiveSubagentRun).toBe(true);
      workerExecution[Symbol.dispose]();
      subagentRuns.delete(workerRun.runId);
      publishSubagentRunChanges([worker, child], [workerRun.runId]);
      expect((await read()).get(parent)?.hasActiveSubagentRun).not.toBe(true);
    } finally {
      subagentRuns.delete(controllerRun.runId);
      subagentRuns.delete(workerRun.runId);
    }
  });
});

it("projects send policy and recipient restrictions, clearing them when the current role permits sending", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = rolePolicyConfig();
    cfg.gateway!.roles!.definitions.write!.sandbox = "required";
    cfg.gateway!.roles!.definitions.restricted = {
      sessions: { others: "write" },
      agents: ["other"],
      scopes: ["operator.read", "operator.write"],
    };
    cfg.session = {
      sendPolicy: { rules: [{ action: "deny", match: { keyPrefix: "policy-blocked" } }] },
    };
    const profiles = ["write", "view", "suggest", "restricted"].map((role) => {
      const profile = ensureProfileForEmail(`${role}@send-presentation.test`);
      setUserProfileRole(profile.id, role);
      return profile;
    });
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const clients = profiles.map((profile) => profileClient(profile.id));
    const creatorId = clients[0]!.authenticatedUserProfile!.profileId;
    const keys = ["host", "sandbox", "entry-blocked", "policy-blocked"];
    for (const key of keys) {
      seedRow(`agent:main:${key}`, {
        sessionId: key,
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: creatorId },
        ...(key === "host" ? {} : { sandbox: "required" as const }),
        ...(key === "entry-blocked" ? { sendPolicy: "deny" as const } : {}),
      });
    }
    using projection = await createTestProjection({ cfg, modelCatalog: [] });
    const reasonFor = (index: number, key: string) =>
      prepareProjectedSessionPresentation(projection, clients[index]!).snapshot({
        agentId: "main",
        key: `agent:main:${key}`,
      }).row?.sendDisabledReason;
    for (const [index, key, reason] of [
      [
        0,
        "host",
        'Your operator role requires a sandboxed session; create a new session instead of running in "agent:main:host".',
      ],
      [0, "sandbox", null],
      [0, "entry-blocked", "send blocked by session policy"],
      [0, "policy-blocked", "send blocked by session policy"],
      [1, "sandbox", "session is shared for this connection"],
      [2, "sandbox", "session is shared for this connection"],
      [
        3,
        "sandbox",
        'Your operator role cannot create sessions for agent "main"; choose an allowed agent or ask a gateway administrator to update your role.',
      ],
    ] as const) {
      expect(reasonFor(index, key)).toBe(reason);
    }
    setUserProfileRole(creatorId, "view");
    prepareGatewayRecipientProfile(clients[0]!);
    expect(reasonFor(0, "host")).toBeNull();
  });
});

it.each(["running", "queued", "capacity-wait"] as const)(
  "projects %s follow-up activity through completed subagent lineage outside the selected list page",
  async (state) => {
    using _ = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg = rolePolicyConfig();
      const parent = "agent:main:parent";
      const child = "agent:main:subagent:child";
      const grandchild = "agent:main:subagent:grandchild";
      const movedParent = "agent:main:moved-parent";
      const endedAt = Date.now() - 3_600_000;
      const recordCompleted = (
        runId: string,
        childSessionKey: string,
        requesterSessionKey: string,
      ) => {
        const entry = createSubagentRunRecord({
          runId,
          childSessionKey,
          requesterSessionKey,
          requesterDisplayKey: requesterSessionKey,
          createdAt: endedAt - 1_000,
          startedAt: endedAt - 1_000,
          endedAt,
          outcome: { status: "ok" },
          ...(runId.startsWith("retained-") ? { delivery: { status: "not_required" } } : {}),
        });
        subagentRuns.set(runId, entry);
        subagentRuns.commitOwnership(entry);
        return runId;
      };
      for (const [key, owner] of [
        [parent],
        [movedParent],
        [child, parent],
        [grandchild, child],
      ] as const) {
        seedRow(key, {
          sessionId: key,
          updatedAt: endedAt,
          label: key === parent ? "Selected parent" : "Hidden child",
          status: "done",
          endedAt,
          ...(owner ? { spawnedBy: owner } : {}),
        });
        if (owner) {
          recordCompleted(`original:${key}`, key, owner);
        }
      }
      const retainedRunIds: string[] = [];
      if (state === "running") {
        for (let index = 0; index < 2_048; index++) {
          retainedRunIds.push(
            recordCompleted(
              `retained-history-${index}`,
              `agent:main:subagent:retained-${index}`,
              "agent:main:unrelated-parent",
            ),
          );
        }
      }
      const projection = await createSessionRowProjection({ cfg });
      const connection = createGatewayConnectionState({
        scheduler: createTestGatewayScheduler(),
        bootId: "follow-up",
        cfg,
      });
      const runId = "follow-up";
      const claim = claimAgentRunContext(
        runId,
        {
          agentId: "main",
          sessionKey: grandchild,
          sessionId: grandchild,
          ...(state === "capacity-wait" ? {} : { projectSessionActive: true }),
        },
        { trackOwner: true, ownsContext: true },
      );
      const releaseWait =
        state === "running"
          ? undefined
          : registerAgentRunCapacityWait(runId, getAgentRunLifecycleGeneration());
      try {
        const list = () =>
          listProjectedSessions({
            projection,
            opts: { search: "Selected parent", limit: 1 },
          });
        const active = await list();
        expect(active.sessions).toHaveLength(1);
        expect(active.sessions[0]).toMatchObject({
          key: parent,
          hasActiveSubagentRun: true,
          childSessions: [child],
        });
        if (retainedRunIds.length) {
          const history = projection.state.rowContext.subagentRuns.latestRunsByChildSessionKey;
          const iterate = history[Symbol.iterator].bind(history);
          let visited = 0;
          const historyIterator = vi
            .spyOn(history, Symbol.iterator)
            .mockImplementation(function* () {
              for (const entry of iterate()) {
                visited++;
                yield entry;
              }
              return undefined;
            });
          seedRow(movedParent, {
            sessionId: movedParent,
            updatedAt: endedAt + 1,
            label: "Unrelated update",
          });
          expect((await list()).sessions[0]?.hasActiveSubagentRun).toBe(true);
          expect(visited).toBeLessThan(16);
          historyIterator.mockRestore();
        }
        const presentation = prepareProjectedSessionPresentation(
          projection,
          undefined,
          Date.now(),
          createVisibleActiveSessionRunProjector(projection.state.rowContext.projectedAgentRuns),
        );
        expect(presentation.snapshot({ key: child, agentId: "main" }).row).toMatchObject({
          hasActiveSubagentRun: true,
          childSessions: [grandchild],
        });
        expect(presentation.snapshot({ key: grandchild, agentId: "main" }).row).toMatchObject({
          hasActiveSubagentRun: true,
          subagentRunState: "historical",
        });
        const originalChild = subagentRuns.get(`original:${child}`)!;
        const movedChild = {
          ...originalChild,
          generation: 2,
          requesterSessionKey: movedParent,
          controllerSessionKey: movedParent,
          execution: { status: "running" as const, startedAt: Date.now() },
        };
        using movedExecution = holdSubagentExecution(movedChild.runId, child);
        subagentRuns.set(movedChild.runId, movedChild);
        subagentRuns.commitOwnership(movedChild);
        expect((await list()).sessions[0]?.hasActiveSubagentRun).not.toBe(true);
        expect(projection.snapshot({ key: movedParent, agentId: "main" }).row).toMatchObject({
          hasActiveSubagentRun: true,
          childSessions: [child],
        });
        releaseWait?.();
        releaseAgentRunContext(runId, claim);
        movedExecution[Symbol.dispose]();
        const finishedChild = {
          ...movedChild,
          execution: { ...movedChild.execution, status: "terminal" as const, endedAt: Date.now() },
        };
        subagentRuns.set(finishedChild.runId, finishedChild);
        subagentRuns.commitOwnership(finishedChild);
        const stopped = await list();
        expect(stopped.sessions[0]?.hasActiveSubagentRun).not.toBe(true);
        expect(stopped.sessions[0]?.childSessions).toEqual([child]);
        const movedRow = projection.snapshot({ key: movedParent, agentId: "main" }).row;
        expect(movedRow?.hasActiveSubagentRun).not.toBe(true);
        expect(movedRow?.childSessions).toBeUndefined();
        expect(subagentRuns.get(`original:${grandchild}`)?.execution.endedAt).toBe(endedAt);
      } finally {
        releaseWait?.();
        releaseAgentRunContext(runId, claim);
        projection.dispose();
        await connection.mentionInbox.dispose();
        for (const key of [child, grandchild]) {
          subagentRuns.delete(`original:${key}`);
        }
        for (const retainedRunId of retainedRunIds) {
          subagentRuns.delete(retainedRunId);
        }
      }
    });
  },
);

it("keeps a live controller's child list consistent with the child's session identity", async () => {
  using clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(1_800_000_000_000);
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const parent = "agent:main:dashboard:navigation-parent";
    const controller = "agent:main:dashboard:controller";
    const child = "agent:main:dashboard:controlled-child";
    const childIdentity = { sessionId: "controlled-child", lifecycleRevision: "generation-1" };
    const childEntry = { ...childIdentity, updatedAt: Date.now(), parentSessionKey: parent };
    seedRow(parent, { sessionId: "navigation-parent", updatedAt: Date.now() });
    seedRow(controller, {
      sessionId: "controller",
      updatedAt: Date.now(),
      label: "Selected controller",
    });
    seedRow(child, childEntry);
    const run = createSubagentRunRecord({
      runId: "controlled-follow-up",
      childSessionKey: child,
      childSessionIdentity: childIdentity,
      requesterSessionKey: controller,
      controllerSessionKey: controller,
      startedAt: Date.now(),
    });
    using _ = holdSubagentExecution(run.runId, child);
    subagentRuns.set(run.runId, run);
    subagentRuns.commitOwnership(run);
    try {
      using projection = await createTestProjection({ cfg: rolePolicyConfig(), modelCatalog: [] });
      const readController = async () => {
        const result = await listProjectedSessions({
          projection,
          opts: { search: "Selected controller", limit: 1 },
        });
        expect(result.sessions).toHaveLength(1);
        return result.sessions[0]!;
      };
      const controllerRow = await readController();
      expect(projection.snapshot({ agentId: "main", key: child }).row).toMatchObject({
        ...childIdentity,
        parentSessionKey: parent,
        controlOwnerSessionKey: controller,
      });
      expect(controllerRow.childSessions).toEqual([child]);
      expect((await readController()).childSessions).toEqual([child]);
      // A reset keeps the key and session ID but must revoke the old run's ownership.
      seedRow(child, { ...childEntry, lifecycleRevision: "generation-2" });
      expect((await readController()).childSessions).toBeUndefined();
      expect(projection.snapshot({ agentId: "main", key: parent }).row?.childSessions).toEqual([
        child,
      ]);
    } finally {
      subagentRuns.delete(run.runId);
    }
  });
});

it("selects collector children only when the recipient has a sharing filter", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const owner = ensureProfileForEmail("collector-owner@presentation.test");
    const viewer = ensureProfileForEmail("collector-viewer@presentation.test");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const parent = "agent:main:dashboard:collector-visibility";
    const visible = "agent:main:subagent:collector-visible";
    const hidden = "agent:main:subagent:collector-hidden";
    const createdActor = { type: "human" as const, source: "profile" as const, id: owner.id };
    seedRow(parent, { sessionId: parent, updatedAt: 1, createdActor, visibility: "shared" });
    const runs = [visible, hidden].map((key, index) => {
      seedRow(key, {
        sessionId: key,
        updatedAt: 1,
        createdActor,
        visibility: key === hidden ? "draft" : "shared",
        parentSessionKey: parent,
      });
      const run = createSubagentRunRecord({
        runId: `collector-visibility-${index}`,
        childSessionKey: key,
        childSessionIdentity: { sessionId: key },
        requesterAgentId: "main",
        requesterSessionKey: parent,
        swarmRequesterSessionKey: parent,
        collect: true,
        groupId: "collector-visibility",
        createdAt: index + 1,
        endedAt: 3,
        collectorCompletion: { status: "done" },
        expectsCompletionMessage: false,
      });
      subagentRuns.set(run.runId, run);
      return run;
    });
    try {
      using projection = await createTestProjection({ cfg: rolePolicyConfig(), modelCatalog: [] });
      await projection.ensureMaterialized();
      const query = { agentId: "main", key: parent };
      const selected = vi.spyOn(projection, "selectEntries");
      const admin = prepareProjectedSessionPresentation(
        projection,
        sharingPolicyClient({ scopes: ["operator.admin"] }),
      );
      const swarm = admin.snapshot(query).row!.swarm!;
      expect(swarm.groups[0]?.children?.map((row) => row.sessionKey)).toEqual([visible, hidden]);
      expect(swarm).toBe(projection.describe(query)!.materialized.row.swarm);
      expect(
        admin
          .snapshot(query, { excludedChildKeys: new Set([hidden]) })
          .row?.swarm?.groups[0]?.children?.map((child) => child.sessionKey),
      ).toEqual([visible]);
      expect(selected).not.toHaveBeenCalled();
      const client = sharingPolicyClient({ user: viewer.id });
      prepareGatewayRecipientProfile(client);
      const restricted = prepareProjectedSessionPresentation(projection, client);
      expect(
        restricted
          .snapshot(query)
          .row?.swarm?.groups[0]?.children?.map((child) => child.sessionKey),
      ).toEqual([visible]);
      expect(selected).toHaveBeenCalledTimes(1);
    } finally {
      for (const run of runs) {
        subagentRuns.delete(run.runId);
      }
    }
  });
});

it("presents current recipient roles without SQLite while rejecting source overrides and excluded children", async () => {
  using clock = vi.spyOn(Date, "now");
  clock.mockReturnValue(1_800_000_000_000);
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const owner = ensureProfileForEmail("owner@presentation.test");
    const member = ensureProfileForEmail("member@presentation.test");
    const viewer = ensureProfileForEmail("viewer@presentation.test");
    setUserProfileRole(viewer.id, "none");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const clients = [owner, member, viewer].map(
      (profile) => createSessionRowEventPeer(profile, profile.id, Date.now()).client,
    );
    const cfg = rolePolicyConfig();
    const query = { agentId: "main", key: "agent:main:parent" };
    const scope = { agentId: "main", sessionKey: query.key };
    const entry = {
      sessionId: "parent-session",
      updatedAt: Date.now(),
      visibility: "suggest" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
    };
    replaceSessionEntrySync(scope, entry);
    seedRow("agent:main:child", {
      sessionId: "child-session",
      updatedAt: Date.now(),
      parentSessionKey: query.key,
    });
    addSessionMember(scope, { identityId: member.id, addedBy: owner.id });
    using projection = await createTestProjection({ cfg });
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "presentation",
      cfg,
    });
    const detach = connection.attachSessionRowProjection(projection);
    for (const client of clients) {
      connection.clients.add(client);
    }
    const presentation = (client?: GatewayWsClient) =>
      prepareProjectedSessionPresentation(projection, client);
    const clearSends = () => clients.forEach((client) => vi.mocked(client.socket).send.mockClear());
    const broadcast = () =>
      connection.broadcast("sessions.changed", { sessionKey: query.key, agentId: query.agentId });
    const broadcastTo = (connIds: string[], payload = {}) =>
      connection.broadcastToConnIds(
        "sessions.changed",
        { sessionKey: query.key, agentId: query.agentId, ...payload },
        new Set(connIds),
      );
    const expectActive = (runIds: string[], states = [true]) => {
      for (const client of clients.slice(0, 2)) {
        const sends = vi.mocked(client.socket).send.mock.calls;
        expect(sends).toHaveLength(states.length);
        for (const [index, hasActiveRun] of states.entries()) {
          expect(JSON.parse(String(sends[index]?.[0])).payload.session).toMatchObject({
            hasActiveRun,
            activeRunIds: hasActiveRun ? runIds : [],
          });
        }
      }
      expect(vi.mocked(clients[2]!.socket).send.mock.calls).toHaveLength(0);
    };
    const sourceAdapter = {};
    const registerSource = (
      runId: string,
      sessionKey: string,
      sessionId: string,
      agentId?: string,
    ) => {
      const source = createRpcSourceForTest(sourceAdapter, {
        runId,
        sessionKey,
        sessionId,
        ...(agentId ? { agentId } : {}),
        accepted: true,
        storeScope: resolveSessionStorePathCore(undefined, { agentId: query.agentId }),
      });
      rpcSourceTesting.set(runId, source);
      return source;
    };
    try {
      const captured = projection.describe(query)!;
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      const exec = vi.spyOn(DatabaseSync.prototype, "exec");
      const anonymous = presentation().present(captured);
      expect(anonymous?.sharingRole).toBeUndefined();
      expect(anonymous?.sendDisabledReason).toBeUndefined();
      for (const [index, expectedRole, visible] of [
        [0, "owner", true],
        [1, "member", true],
        [2, "viewer", false],
      ] as const) {
        const client = clients[index]!;
        const recipient = presentation(client);
        const presented = recipient.present(captured, {
          excludedChildKeys: new Set(["agent:main:child"]),
        });
        expect(presented).toMatchObject({
          sharingRole: expectedRole,
          sendDisabledReason:
            expectedRole === "viewer" ? `Session "${query.key}" was not found.` : null,
        });
        expect(presented?.childSessions).toBeUndefined();
        expect(
          canReceiveSessionEvent({
            cfg,
            client,
            sessionKeys: [query.key],
            agentId: "main",
            prepared: {
              sharing: recipient.sharing,
              target: (key) => recipient.target({ ...query, key }),
            },
          }),
        ).toBe(visible);
        expect(recipient.authorizeDescription(query)).toBeNull();
        broadcastTo([client.connId], {
          session: {
            key: query.key,
            sessionId: entry.sessionId,
            label: null,
            sendDisabledReason: "Untrusted source restriction",
            endedAt: null,
            status: "completed",
          },
        });
        const socket = vi.mocked(client.socket);
        if (visible) {
          expect(socket.send.mock.calls).toHaveLength(1);
          const frame = JSON.parse(String(socket.send.mock.calls[0]?.[0]));
          expect(frame.payload.session.sendDisabledReason).toBeNull();
          expect(frame.payload.session).not.toMatchObject({ status: "completed", label: null });
        } else {
          expect(socket.send.mock.calls).toHaveLength(0);
        }
      }
      expect(
        presentation(clients[0]!).authorizeDescription({
          agentId: "main",
          key: "agent:main:dashboard:incognito-private",
        }),
      ).toMatchObject({ code: "INVALID_REQUEST" });
      registerSource("old-run", query.key, entry.sessionId, query.agentId);
      registerSource("unrelated-0", "agent:main:unrelated-0", "unrelated-session-0");
      broadcast();
      // Earlier source-override checks already sent one frame to each visible client.
      for (const client of clients.slice(0, 2)) {
        expect(
          JSON.parse(String(vi.mocked(client.socket).send.mock.lastCall?.[0])).payload.session,
        ).toMatchObject({ hasActiveRun: true, activeRunIds: ["old-run"] });
      }
      clearSends();
      rpcSourceTesting.delete("old-run");
      registerSource(
        "replacement-run",
        "agent:main:adopted-source",
        ` ${entry.sessionId} `,
        query.agentId,
      );
      broadcastTo(clients.map((client) => client.connId));
      expectActive(["replacement-run"]);
      const replacement = rpcSourceTesting.get("replacement-run")!;
      for (const change of ["session-id", "session-key", "terminal", "agent"] as const) {
        setRpcSourceIdentityForTest(replacement, {
          sessionKey: change === "session-key" ? query.key : "agent:main:adopted-source",
          sessionId: change === "session-key" ? "adopted-session" : entry.sessionId,
          agentId: query.agentId,
        });
        setRpcSourceTerminalProjectionForTest(replacement, false);
        clearSends();
        broadcast();
        if (change === "session-id") {
          setRpcSourceIdentityForTest(replacement, { sessionId: "adopted-session" });
        } else if (change === "session-key") {
          setRpcSourceIdentityForTest(replacement, {
            sessionKey: "agent:main:adopted-source",
          });
        } else if (change === "terminal") {
          setRpcSourceTerminalProjectionForTest(replacement, true);
        } else {
          setRpcSourceIdentityForTest(replacement, { agentId: "other" });
        }
        broadcast();
        expectActive(["replacement-run"], [true, false]);
      }
      setRpcSourceIdentityForTest(replacement, {
        sessionKey: query.key,
        sessionId: entry.sessionId,
        agentId: query.agentId,
      });
      setRpcSourceTerminalProjectionForTest(replacement, false);
      const joining = rpcSourceTesting.get("unrelated-0")!;
      clearSends();
      setRpcSourceIdentityForTest(joining, { sessionKey: query.key });
      broadcast();
      expectActive(["replacement-run", "unrelated-0"]);
      rpcSourceTesting.clear();
      expect(prepares).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      prepares.mockRestore();
      exec.mockRestore();
      removeSessionMember(scope, member.id);
      await projection.ensureMaterialized();
      expect(presentation(clients[1]!).snapshot(query).row?.sharingRole).toBe("viewer");
      replaceSessionEntrySync(scope, { ...entry, sessionId: "replacement-session" });
      await projection.ensureMaterialized();
      expect(presentation(clients[0]!).present(captured)).toBeNull();
      const socket = vi.mocked(clients[0]!.socket);
      socket.send.mockClear();
      for (const payload of [
        { sessionId: entry.sessionId, session: { sessionId: "replacement-session" } },
        { session: { sessionId: entry.sessionId } },
        { session: { sessionId: "replacement-session", lifecycleRevision: "retired" } },
      ]) {
        broadcastTo([clients[0]!.connId], payload);
      }
      expect(socket.send.mock.calls).toHaveLength(0);
    } finally {
      detach();
      await connection.mentionInbox.dispose();
    }
  });
});

it("preserves selected account across role changes but rejects a changed merge identity without SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const source = ensureProfileForEmail("source@expected-profile.test");
    const target = ensureProfileForEmail("target@expected-profile.test");
    const client = profileClient(source.id) as GatewayWsClient;
    const release = (await prepareUserProfileCatalog()).release;
    try {
      const binding = (await createExpectedProfileBinding(source.id, client))!;
      const targetBinding = (await createExpectedProfileBinding(
        target.id,
        sharingPolicyClient({ user: target.id }),
      ))!;
      binding.markInvoked();
      setUserProfileRole(source.id, "admin");
      setUserProfileRole(source.id, "member");
      linkEmail("extra@expected-profile.test", source.id);
      const prepares = vi.spyOn(DatabaseSync.prototype, "prepare");
      binding.assertCurrent();
      const response = vi.fn();
      binding.guardResponse(response)(true, { session: null });
      expect(response).toHaveBeenCalledWith(true, { session: null });
      expect(prepares).not.toHaveBeenCalled();
      prepares.mockRestore();
      // Moving the last alias triggers the source profile's canonical merge.
      linkEmail("extra@expected-profile.test", target.id);
      linkEmail("source@expected-profile.test", target.id);
      prepareGatewayRecipientProfile(client);
      const afterMerge = vi.spyOn(DatabaseSync.prototype, "prepare");
      expect(() => binding.assertCurrent()).toThrow(ExpectedProfileMismatchError);
      expect(() => targetBinding.assertCurrent()).not.toThrow();
      expect(readResidentUserProfileIdentity(source.id)?.profileId).toBe(target.id);
      expect(afterMerge).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });
});

it("reuses unchanged run presentation and refreshes follow-up activity and row replacements", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:subagent:progress-fact";
    const entry = {
      sessionId: "progress-fact",
      updatedAt: 1,
      status: "done" as const,
      spawnedBy: "agent:main:parent",
    };
    seedRow(key, entry);
    using projection = await createTestProjection({ cfg: {}, modelCatalog: [] });
    const list = () => listProjectedSessions({ projection, opts: { limit: 10 } });
    const active = async () =>
      (await list()).sessions.find((row) => row.key === key)?.hasActiveSubagentRun;
    expect(await active()).not.toBe(true);
    const index = projection.state.rowContext.projectedAgentRuns!;
    using keys = vi.spyOn(index.sessionKeys, "get");
    using ids = vi.spyOn(index.sessionIds, "get");
    using states = vi.spyOn(preparedRead, "projectPreparedSessionRunState");
    await list();
    const initialState = states.mock.results.at(-1)?.value;
    await list();
    expect(initialState).toBeDefined();
    expect(states.mock.results.at(-1)?.value).toBe(initialState);
    expect(keys).not.toHaveBeenCalled();
    expect(ids).not.toHaveBeenCalled();

    const claim = claimAgentRunContext(
      "progress-fact-follow-up",
      { agentId: "main", sessionId: "progress-fact", projectSessionActive: true },
      { trackOwner: true, ownsContext: true },
    );
    try {
      expect(await active()).toBe(true);
      const activeState = states.mock.results.at(-1)?.value;
      expect(activeState).not.toBe(initialState);
      expect(initialState.fields.hasActiveSubagentRun).not.toBe(true);
      await list();
      expect(states.mock.results.at(-1)?.value).toBe(activeState);
      seedRow(key, { ...entry, sessionId: "replacement-session", updatedAt: 2 });
      expect(await active()).not.toBe(true);
    } finally {
      releaseAgentRunContext("progress-fact-follow-up", claim);
    }
    expect(await active()).not.toBe(true);
  });
});

it("refreshes live elapsed time but retains completed run presentation across clocks", async () => {
  using clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:subagent:elapsed-presentation";
    const runId = "elapsed-presentation";
    const startedAt = Date.now() - 1_000;
    seedRow(key, { sessionId: "elapsed-presentation", updatedAt: startedAt });
    const running = createSubagentRunRecord({
      runId,
      childSessionKey: key,
      requesterSessionKey: "agent:main:parent",
      requesterDisplayKey: "parent",
      createdAt: startedAt,
      startedAt,
    });
    subagentRuns.set(runId, running);
    subagentRuns.commitOwnership(running);
    const execution = holdSubagentExecution(runId, key);
    publishSubagentRunChanges([runId]);
    try {
      using projection = await createTestProjection({ cfg: {}, modelCatalog: [] });
      using states = vi.spyOn(preparedRead, "projectPreparedSessionRunState");
      const list = () => listProjectedSessions({ projection, opts: { limit: 10 } });
      expect((await list()).sessions[0]?.runtimeMs).toBe(1_000);
      const first = states.mock.results.at(-1)?.value;
      clock.mockReturnValue(startedAt + 2_000);
      expect((await list()).sessions[0]?.runtimeMs).toBe(2_000);
      expect(states.mock.results.at(-1)?.value).not.toBe(first);
      expect(first.fields.runtimeMs).toBe(1_000);

      execution[Symbol.dispose]();
      const completed = createSubagentRunRecord({
        runId,
        childSessionKey: key,
        requesterSessionKey: "agent:main:parent",
        requesterDisplayKey: "parent",
        createdAt: startedAt,
        startedAt,
        endedAt: Date.now(),
        outcome: { status: "ok" },
      });
      subagentRuns.set(runId, completed);
      subagentRuns.commitOwnership(completed);
      publishSubagentRunChanges([runId]);
      expect((await list()).sessions[0]?.runtimeMs).toBe(2_000);
      const finished = states.mock.results.at(-1)?.value;
      clock.mockReturnValue(startedAt + 3_000);
      expect((await list()).sessions[0]?.runtimeMs).toBe(2_000);
      expect(states.mock.results.at(-1)?.value).toBe(finished);
    } finally {
      execution[Symbol.dispose]();
      subagentRuns.delete(runId);
      publishSubagentRunChanges([runId]);
    }
  });
});
