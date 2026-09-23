import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { ResponseFrame } from "../../../../packages/gateway-protocol/src/schema/frames.js";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
  WORKER_RPC_SET_VERSION,
  WORKER_SESSION_TOOLS_PROTOCOL_FEATURE,
} from "../../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { PROTOCOL_VERSION } from "../../../../packages/gateway-protocol/src/version.js";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import { createOperationalRunInstanceRef } from "../../../agents/admitted-run-context.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../../../agents/embedded-agent-runner/runs.js";
import { guardSessionManager } from "../../../agents/session-tool-result-guard-wrapper.js";
import { SessionManager } from "../../../agents/sessions/session-manager.js";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import { retainLegacyDefaultAgentId } from "../../../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { collectActiveSessionWorkAdmissions } from "../../../sessions/session-lifecycle-admission.js";
import { attachRuntimeUserTurnTranscriptContext } from "../../../sessions/user-turn-transcript-runtime-context.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "../../methods/registry.js";
import { GatewayConnectionWork } from "../../server-connection-work.js";
import {
  disposeSessionReadContexts,
  initializeSessionReadContext,
  sessionReadHandlers,
} from "../../server-methods/sessions-read-cache.test-support.js";
import { createContext } from "../../server-plugin-in-process-dispatch.test-support.js";
import { getSessionRowProjection } from "../../session-row-projection-access.js";
import type { WorkerInstallationArtifact } from "../../worker-environments/bundle.js";
import { createWorkerSessionPlacementStore } from "../../worker-environments/placement-store.js";
import { writePlacementEnvironmentFixture } from "../../worker-environments/placement-test-fixtures.js";
import { bindWorkerTurnOwner } from "../../worker-environments/placement-turn-claim-events.js";
import { createWorkerSessionPlacementGate } from "../../worker-environments/placement-worker-gate.js";
import { createWorkerEnvironmentService } from "../../worker-environments/service.js";
import { createWorkerEnvironmentStore } from "../../worker-environments/store.js";
import { createWorkerSessionToolExecutor } from "../../worker-environments/worker-session-tool-executor.js";
import { createGatewayWsTestSocket } from "../ws-connection.test-helpers.js";
import type { GatewayWsClient } from "../ws-types.js";
import { terminal } from "./message-handler.worker-session-owner.mocks.test-support.js";
import { attachWorkerWsMessageHandler } from "./worker-connection.js";

export const OWNER_PARENT = {
  agentId: "ops",
  sessionKey: "global",
  sessionId: "00000000-0000-4000-8000-000000000001",
};
export const OWNER_SOURCE = {
  agentId: "worker",
  sessionKey: "agent:worker:dashboard:child",
  sessionId: "00000000-0000-4000-8000-000000000002",
};
export const OWNER_SIBLING = {
  agentId: "worker",
  sessionKey: "agent:worker:dashboard:sibling",
  sessionId: "00000000-0000-4000-8000-000000000003",
};

const handshake = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.9.1",
  protocolFeatures: [
    WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
    WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
    WORKER_SESSION_TOOLS_PROTOCOL_FEATURE,
  ],
};
const installation: WorkerInstallationArtifact = {
  ...handshake,
  install: "bundle",
  tarballBytes: 1,
  tarballSha256: "b".repeat(64),
  tarballPath: "/synthetic/worker.tgz",
};

export type OwnerLayout = "per-agent" | "fixed";
type EntryIdentity = { agentId: string; sessionKey: string; sessionId: string };
type OwnerFixture = Awaited<ReturnType<typeof createOwnerFixture>>;
type FixtureCleanup = () => void | Promise<void>;
type OwnerFixtureData = { mainGlobalAbsent?: boolean };

async function createOwnerFixture(
  state: OpenClawTestState,
  layout: OwnerLayout,
  cleanups: FixtureCleanup[],
  data: OwnerFixtureData,
) {
  const cfg = retainLegacyDefaultAgentId(
    {
      agents: {
        entries: { main: {}, ops: {}, worker: {} },
        ...(layout === "fixed" ? { defaults: { sessionStore: { agentId: "ops" } } } : {}),
      },
      session: {
        scope: "global",
        ...(layout === "fixed" ? { store: state.statePath("shared.sqlite") } : {}),
      },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: ["*"] } },
    } satisfies OpenClawConfig,
    "main",
  );
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  const entries = new Map<string, SessionEntry>();
  const entryKey = (identity: EntryIdentity) => `${identity.agentId}\0${identity.sessionKey}`;
  const write = (identity: EntryIdentity, patch: Partial<SessionEntry> = {}) => {
    const entry = {
      sessionId: identity.sessionId,
      updatedAt: 1,
      visibility: "shared" as const,
      ...entries.get(entryKey(identity)),
      ...patch,
    };
    entries.set(entryKey(identity), entry);
    replaceSessionEntrySync(
      {
        agentId: identity.agentId,
        sessionKey: identity.sessionKey,
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: identity.agentId }),
      },
      entry,
    );
  };
  if (layout === "per-agent") {
    write({
      agentId: "main",
      sessionKey: data.mainGlobalAbsent ? "agent:main:dashboard:decoy" : "global",
      sessionId: "unrelated-parent",
    });
  }
  write(OWNER_PARENT);
  const lineage = {
    parentSessionKey: OWNER_PARENT.sessionKey,
    parentSessionId: OWNER_PARENT.sessionId,
  };
  write(OWNER_SOURCE, lineage);
  write(OWNER_SIBLING, lineage);

  const context = createContext();
  context.getRuntimeConfig = () => cfg;
  context.chatAbortControllers = new Map();
  context.getSessionEventSubscriberConnIds = () => new Set();
  context.loadGatewayModelCatalog = async () => [];
  const registry = createGatewayMethodRegistry([
    ...["sessions.resolve", "sessions.list"].map((name) => ({
      name,
      scope: "operator.read" as const,
      owner: { kind: "core" as const, area: "sessions" },
      handler: sessionReadHandlers[name]!,
    })),
    {
      name: "agent",
      scope: "operator.write",
      owner: { kind: "core", area: "agent" },
      handler: () => {
        throw new Error("Agent dispatch must use its typed facade");
      },
    },
  ]);
  context.getGatewayMethodRegistry = () => registry;
  cleanups.push(disposeSessionReadContexts);
  await initializeSessionReadContext(context);
  const dispatched: Array<{ agentId?: string; sessionKey?: string; message: string }> = [];
  terminal.startTurn.mockReset();
  terminal.startTurn.mockImplementation(async ({ preflight, io, assertAdmissionCurrent }) => {
    assertAdmissionCurrent?.();
    const request = preflight.request;
    const agentId = request.agentId!;
    const sessionKey = request.sessionKey!;
    const entry = entries.get(`${agentId}\0${sessionKey}`);
    expect(entry).toBeDefined();
    const admissions = collectActiveSessionWorkAdmissions();
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
    expect(
      [...(admissions.get(storePath) ?? [])],
      JSON.stringify([...admissions].map(([store, keys]) => [store, [...keys]])),
    ).toEqual(expect.arrayContaining([sessionKey, entry!.sessionId]));
    dispatched.push({ agentId, sessionKey, message: request.message });
    io.emitAcceptance([true, { runId: preflight.runId, status: "accepted" }, undefined]);
  });

  const database = openOpenClawStateDatabase();
  const environments = await createWorkerEnvironmentStore({ database });
  const placements = createWorkerSessionPlacementStore({ database });
  const environmentId = "owner-proof-worker";
  writePlacementEnvironmentFixture(database, {
    environmentId,
    ownerEpoch: 1,
    state: "attached",
    attachedSessionIds: [OWNER_SOURCE.sessionId],
    profileSnapshot: { install: "bundle", settings: {} },
    bootstrapReceipt: handshake,
  });
  let placement = placements.startDispatch(OWNER_SOURCE);
  for (const [from, to, patch] of [
    ["requested", "provisioning", { environmentId }],
    ["provisioning", "syncing", { workerBundleHash: handshake.bundleHash }],
    [
      "syncing",
      "starting",
      {
        workspaceBaseManifestRef: "synthetic-manifest",
        remoteWorkspaceDir: "/synthetic/workspace",
      },
    ],
    ["starting", "active", { activeOwnerEpoch: 1 }],
  ] as const) {
    placement = placements.transition({
      sessionId: OWNER_SOURCE.sessionId,
      from,
      to,
      expectedGeneration: placement.generation,
      patch,
    });
  }
  const claim = placements.claimTurn({
    ...OWNER_SOURCE,
    claimId: "owner-proof-claim",
    runId: "owner-proof-run",
    owner: { kind: "worker", environmentId, ownerEpoch: 1 },
  });
  placements.authorizeWorkerTurnTools(claim, ["sessions_send"]);
  const run = createOperationalRunInstanceRef(claim.runId);
  const authority = claimAgentRunDelegatedAuthority(run);
  cleanups.push(() => {
    releaseAgentRunDelegatedAuthority(authority);
  });
  const rootAdmission = tryBeginGatewayRootWorkAdmission();
  if (!rootAdmission) {
    throw new Error("Could not admit the synthetic worker turn");
  }
  cleanups.push(() => rootAdmission.release());
  cleanups.push(async () => {
    await placements.closeWorkerTurnToolState(claim);
    placements.releaseTurn(claim);
  });
  await rootAdmission.run(async () => {
    bindWorkerTurnOwner(
      placements,
      claim,
      undefined,
      run,
      {
        ...OWNER_SOURCE,
        storePath: resolveSessionStorePathCore(cfg.session?.store, {
          agentId: OWNER_SOURCE.agentId,
        }),
      },
      () => {},
    );
  });
  const service = createWorkerEnvironmentService({
    store: environments,
    getConfig: () => cfg,
    resolveProvider: () => undefined,
    prepareInstallation: async () => installation,
    bootstrapWorker: async () => handshake,
    resolveSshIdentity: async () => ({ kind: "path", path: "/synthetic/unused" }),
    executeInference: async () => {
      throw new Error("Send must not start worker inference");
    },
    placementStore: createWorkerSessionPlacementGate(placements),
    executeSessionTool: (request) => executor(request),
  });
  cleanups.push(() => service.stop());
  const executor = createWorkerSessionToolExecutor({
    resolveGatewayContext: () => context,
    placements,
    environments: service,
    dispatchChild: async () => {
      throw new Error("Send must not dispatch a worker");
    },
    portals: { getService: () => undefined, carrier: { open: vi.fn() }, onChanged: vi.fn() },
  });
  const credential = await service.acquireTurnCredential(claim);
  const socket = createGatewayWsTestSocket();
  const connectionWork = new GatewayConnectionWork();
  const responses = new Map<string, ReturnType<typeof createDeferredCore<ResponseFrame>>>();
  let client: GatewayWsClient | null = null;
  let closed = false;
  const cleanup = attachWorkerWsMessageHandler({
    socket: socket as unknown as WebSocket,
    connectionWork,
    connId: "owner-proof-connection",
    service,
    publicAdmission: { clientIp: "203.0.113.10", rateLimiter: undefined },
    send: (value) => {
      const response = value as ResponseFrame;
      responses.get(response.id)?.resolve(response);
      return { kind: "sent" };
    },
    close: (_code, reason) => {
      closed = true;
      for (const response of responses.values()) {
        response.reject(new Error(`Worker connection closed: ${reason}`));
      }
    },
    isClosed: () => closed,
    clearHandshakeTimer: () => {},
    getClient: () => client,
    setClient: (next) => {
      client = next;
      return true;
    },
    setHandshakeState: () => {},
    advanceHandshakePhase: () => {},
    setCloseCause: () => {},
    setLastFrameMeta: () => {},
    logGateway: { warn: vi.fn() },
    logWsControl: { warn: vi.fn() },
  });
  cleanups.push(async () => {
    cleanup();
    connectionWork.beginClose();
    await connectionWork.drain();
  });
  let ordinal = 0;
  const request = async (method: string, params: unknown) => {
    const id = `owner-proof-${++ordinal}`;
    const response = createDeferredCore<ResponseFrame>();
    responses.set(id, response);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "req", id, method, params })));
    try {
      return await response.promise;
    } finally {
      responses.delete(id);
    }
  };
  const connected = await request("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: GATEWAY_CLIENT_IDS.WORKER,
      version: handshake.openclawVersion,
      platform: "linux",
      mode: GATEWAY_CLIENT_MODES.WORKER,
    },
    role: "worker",
    admission: {
      environmentId,
      credential: credential.credential,
      sessionId: claim.sessionId,
      runId: claim.runId,
      ownerEpoch: 1,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      handshake,
    },
  });
  expect(connected.ok).toBe(true);
  const send = (sessionKey: string, toolCallId: string) =>
    request("worker.sessions.send", {
      toolCallId,
      sessionKey,
      message: `Synthetic ${toolCallId}`,
      timeoutSeconds: 0,
    });
  const installQueuedSibling = async (options: {
    supportsTranscriptCommitWait: boolean;
    pause?: "prepare" | "commit";
  }) => {
    const target = {
      agentId: "worker",
      sessionKey: "agent:worker:dashboard:queued:run:current",
      sessionId: "00000000-0000-4000-8000-000000000004",
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: "worker" }),
    };
    write(target, lineage);
    await expectDefined(
      getSessionRowProjection(context),
      "owner fixture projection",
    ).ensureMaterialized();
    const manager = guardSessionManager(SessionManager.open(target, state.root), {
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      config: cfg,
    });
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let accepted = 0;
    const pause = async (phase: "prepare" | "commit") => {
      if (options.pause === phase) {
        entered.resolve();
        await release.promise;
      }
    };
    const queueMessage = vi.fn<
      NonNullable<EmbeddedAgentQueueHandle["messageInjectionV2"]>["queueMessage"]
    >(async (text, queueOptions, assertCurrent) => {
      const recorder = expectDefined(
        queueOptions?.userTurnTranscriptRecorder,
        "queued worker recorder",
      );
      const message = expectDefined(await recorder.resolveMessage(), "queued worker input");
      await pause("prepare");
      assertCurrent();
      accepted += 1;
      // Queue acceptance and a later transcript commit are separate effects.
      // The real recorder must fence the SQLite append after this yield.
      await pause("commit");
      manager.appendMessage(
        attachRuntimeUserTurnTranscriptContext(
          { role: "user", content: text, timestamp: 1 },
          { message, recorder },
        ),
      );
    });
    const handle: EmbeddedAgentQueueHandle = {
      queueMessage: async () => {
        throw new Error("Queued worker input requires the V2 carrier");
      },
      messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
      supportsTranscriptCommitWait: options.supportsTranscriptCommitWait,
      isStreaming: () => true,
      isCompacting: () => false,
      sourceReplyDeliveryMode: "message_tool_only",
      abort: () => {},
    };
    setActiveEmbeddedRun(target.sessionId, handle, target.sessionKey, undefined, target.agentId);
    cleanups.push(() => clearActiveEmbeddedRun(target.sessionId, handle, target.sessionKey));
    return {
      target,
      entered: entered.promise,
      release: () => release.resolve(),
      queueMessage,
      get accepted() {
        return accepted;
      },
      messages: () =>
        SessionManager.open(target, state.root)
          .getEntries()
          .filter((entry) => entry.type === "message"),
    };
  };
  return {
    cfg,
    context,
    write,
    send,
    dispatched,
    installQueuedSibling,
    observeSql: () => observeWorkerOwnerSql(state.env),
    revokeSource: () => releaseAgentRunDelegatedAuthority(authority),
  };
}

export async function withWorkerOwnerFixture(
  layout: OwnerLayout,
  run: (fixture: OwnerFixture) => Promise<void>,
  data: OwnerFixtureData = {},
) {
  return await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cleanups: FixtureCleanup[] = [];
    const errors: unknown[] = [];
    try {
      const fixture = await createOwnerFixture(state, layout, cleanups, data);
      await run(fixture);
    } catch (error) {
      errors.push(error);
    }
    for (const cleanup of cleanups.toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      resetGatewayWorkAdmission();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "Worker owner fixture and cleanup failed", {
        cause: errors[0],
      });
    }
  });
}

export function resultDetails(response: ResponseFrame): Record<string, unknown> {
  expect(response.ok, JSON.stringify(response.error)).toBe(true);
  const payload = response.payload as { resultJson: string };
  return (JSON.parse(payload.resultJson) as { details: Record<string, unknown> }).details;
}

function observeWorkerOwnerSql(env: NodeJS.ProcessEnv) {
  const sql = observeHostDataSql(env);
  const queryStacks = new Map<number, string>();
  for (const call of sql.calls) {
    call.mockImplementation(() => {
      const previousLimit = Error.stackTraceLimit;
      try {
        Error.stackTraceLimit = Math.max(previousLimit, 64);
        // The observer appends this call's query immediately after invoking the mock.
        queryStacks.set(sql.queries.length, new Error("Host SQLite observation").stack ?? "");
      } finally {
        Error.stackTraceLimit = previousLimit;
      }
    });
  }
  return {
    ...sql,
    queryStacks,
  };
}

export function expectOnlyLegacyWorkerSql(sql: ReturnType<typeof observeWorkerOwnerSql>) {
  const categories = {
    placement: [] as string[],
    authority: [] as string[],
    operation: [] as string[],
    lifecycle: [] as string[],
    placementOwnership: [] as string[],
    placementSchema: [] as string[],
    participantPublication: [] as string[],
    preflight: [] as string[],
    authorization: [] as string[],
    unexpected: [] as string[],
  };
  const unexpectedSamples = new Map<string, { query: string; stack: string; count: number }>();
  for (const [index, query] of sql.queries.entries()) {
    const callStack = sql.queryStacks.get(index) ?? "";
    const normalizedQuery = query.replace(/\s+/gu, " ").trim();
    // Only the unchanged preflight's own call stack qualifies its legacy reader.
    if (sql.queryStacks.get(index)?.includes("/gateway/agent-turn/agent-request-preflight.ts:")) {
      categories.preflight.push(query);
      continue;
    }
    if (
      sql.queryStacks.get(index)?.includes("/gateway/session-sharing.ts:") &&
      sql.queryStacks.get(index)?.includes("/gateway/server-methods.ts:")
    ) {
      categories.authorization.push(query);
      continue;
    }
    if (
      callStack.includes("/config/sessions/session-sharing-store.async.ts:") &&
      (callStack.includes("/sessions/session-row-changes.ts:") ||
        callStack.includes("/sessions/session-lifecycle-events.ts:")) &&
      callStack.includes("/gateway/session-row-projection.ts:") &&
      callStack.includes("/gateway/session-row-membership-read.ts:") &&
      callStack.includes("/gateway/session-row-projection-materialize.ts:") &&
      callStack.includes("/config/sessions/session-accessor.sqlite-entry-read.ts:") &&
      (normalizedQuery ===
        'select schema_version as "schema_version" from pragma_schema_version as "pragma_schema"' ||
        normalizedQuery ===
          `select "session_key", CASE WHEN json_valid(entry_json) THEN CASE WHEN json_type(entry_json, '$.sessionId') = 'text' AND length(CAST(entry_json AS BLOB)) = length(CAST(printf('%s', entry_json) AS BLOB)) THEN json_remove(entry_json, '$.skillsSnapshot', '$.systemPromptReport') ELSE entry_json END ELSE entry_json END as "entry_json", "owner_actor_type", "owner_actor_id", "owner_assigned_by_type", "owner_assigned_by_id", "owner_assigned_at", "current_session_id", "updated_at", cast("session_nodes"."rowid" as text) as "rowid" from "session_nodes" where "session_key" = ?`)
    ) {
      categories.participantPublication.push(query);
      continue;
    }
    if (
      callStack.includes("/gateway/worker-environments/placement-store.ts:") &&
      callStack.includes("/state/openclaw-state-db-runtime-failure.ts:") &&
      callStack.includes("/state/openclaw-state-db-schema-version.ts:") &&
      (normalizedQuery === "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?" ||
        normalizedQuery === 'select "value_json" from "config_machine_state" where "state_key" = ?')
    ) {
      categories.placementSchema.push(query);
      continue;
    }
    if (
      sql.queryStacks.get(index)?.includes("/gateway/worker-environments/placement-store.ts:") &&
      /^(?:PRAGMA data_version|SELECT value_json FROM config_machine_state WHERE state_key = \? LIMIT 1)$/iu.test(
        query.trim(),
      )
    ) {
      categories.placementOwnership.push(query);
      continue;
    }
    const tables = [...query.matchAll(/\b(?:from|join|into|update)\s+"?([a-z_][a-z0-9_]*)/giu)].map(
      (match) => match[1],
    );
    if (tables.length > 0 && tables.every((table) => table === "worker_session_placements")) {
      categories.placement.push(query);
    } else if (
      tables.length > 0 &&
      tables.every((table) => table === "worker_turn_tool_authorities")
    ) {
      categories.authority.push(query);
    } else if (
      tables.length > 0 &&
      tables.every((table) => table === "worker_session_tool_operations")
    ) {
      categories.operation.push(query);
    } else if (
      /^(?:PRAGMA (?:user_version|busy_timeout)(?:\s*=\s*\d+)?|BEGIN(?: IMMEDIATE)?|COMMIT|ROLLBACK)\s*;?$/iu.test(
        query.trim(),
      )
    ) {
      categories.lifecycle.push(query);
    } else {
      categories.unexpected.push(query);
      const stack = (sql.queryStacks.get(index) ?? "Stack unavailable")
        .split("\n")
        .filter(
          (line) =>
            !line.includes("/node_modules/") &&
            !line.includes("sqlite-statement-execution-counter.ts"),
        )
        .join("\n");
      const key = `${query}\0${stack}`;
      const sample = unexpectedSamples.get(key);
      if (sample) {
        sample.count += 1;
      } else {
        unexpectedSamples.set(key, {
          query: query.length > 1200 ? `${query.slice(0, 600)} … ${query.slice(-600)}` : query,
          stack,
          count: 1,
        });
      }
    }
  }
  expect(
    categories.unexpected.length,
    JSON.stringify(
      {
        counts: Object.fromEntries(
          Object.entries(categories).map(([name, queries]) => [name, queries.length]),
        ),
        uniqueUnexpected: unexpectedSamples.size,
        samples: [...unexpectedSamples.values()].slice(0, 16),
        omittedSamples: Math.max(0, unexpectedSamples.size - 16),
      },
      null,
      2,
    ),
  ).toBe(0);
  expect(categories.placement.length).toBeGreaterThan(0);
  expect(categories.authority.length).toBeGreaterThan(0);
  expect(categories.operation.length).toBeGreaterThan(0);
  expect(categories.preflight.length).toBeGreaterThan(0);
  expect(categories.authorization.length).toBeGreaterThan(0);
  expect(Object.values(categories).reduce((count, queries) => count + queries.length, 0)).toBe(
    sql.queries.length,
  );
}
