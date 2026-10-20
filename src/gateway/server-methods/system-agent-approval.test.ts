// Covers delegated system-agent approval ownership and closure.

import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred, awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createSystemAgentTool } from "../../agents/tools/system-agent-tool.js";
import { runConfigSet as runConfigSetCommand } from "../../cli/config-cli.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import {
  SYSTEM_AGENT_APPROVAL_TIMEOUT_MS,
  type SystemAgentApprovalRequestPayload,
} from "../../infra/system-agent-approvals.js";
import { resetPluginStateStoreForTests } from "../../plugin-state/plugin-state-store.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import {
  createSystemAgentVerifiedInferenceTestFixture,
  createSystemAgentPluginMetadataTestSnapshot,
  readLastSystemAgentAuditEntry,
  type SystemAgentPluginMetadataTestSnapshot,
} from "../../system-agent/system-agent.test-helpers.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { installTestApprovalClock } from "../exec-approval-manager.test-support.js";
import { getOperatorApprovalDetailed } from "../operator-approval-store.js";
import { runSystemAgentGatewayTask } from "./system-agent-execution.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const delegation = { agentId: "main", sessionKey: "agent:main:main" };
type Caller = NonNullable<Parameters<typeof withGatewayToolCallerIdentity>[0]>;

function expectReplyParts(payload: unknown, ...parts: string[]) {
  for (const part of parts) {
    expect(payload).toMatchObject({ reply: expect.stringContaining(part) });
  }
}

const expiredGuidance = [
  "expired without a decision",
  "approve it in the Control UI or OpenClaw apps",
  "Retrying alone does not approve the change",
];
const failedGuidance = ["application status is unconfirmed", "before retrying"];
const cancelledGuidance = ["approval request is no longer active", "No change was made"];

const setupInferenceMocks = vi.hoisted(() => ({ resolvePersistentApplyInference: vi.fn() }));
// mock-isolation: Exercise delegated approval without loading the machine's config CLI.
vi.mock("../../cli/config-cli.js", () => ({ runConfigSet: vi.fn() }));
const transcriptStoreMocks = vi.hoisted(() => ({
  appendReset: vi.fn(),
  appendTurn: vi.fn(),
  readTranscriptTailAsync: vi
    .fn<typeof import("../../system-agent/transcript-store.js").readTranscriptTailAsync>()
    .mockResolvedValue([]),
}));

vi.mock("../../system-agent/setup-inference.js", () => ({
  resolvePersistentApplyInference: setupInferenceMocks.resolvePersistentApplyInference,
}));
// mock-isolation: Exercise delegated approval ownership without opening the machine-wide audit store.
vi.mock("../../system-agent/transcript-store.js", () => ({
  readTranscriptTailAsync: transcriptStoreMocks.readTranscriptTailAsync,
  createSystemAgentTranscriptStore: () => ({
    assertCurrent: () => undefined,
    appendTurn: transcriptStoreMocks.appendTurn,
    appendReset: transcriptStoreMocks.appendReset,
    readTail: (limit: number, afterLastReset = false) =>
      afterLastReset
        ? transcriptStoreMocks.readTranscriptTailAsync(limit, { afterLastReset })
        : transcriptStoreMocks.readTranscriptTailAsync(limit),
  }),
}));

afterEach(() => {
  resetAgentRunRegistryForTest();
});

describe("Full Access delegated chat", () => {
  const verifiedConfig: OpenClawConfig = {
    agents: { defaults: { model: "openai/gpt-5.5@openai:verified" } },
    auth: { profiles: { "openai:verified": { provider: "openai", mode: "api_key" } } },
  };
  const systemAgentTempDirs = createTempDirTracker();
  const approvalManagers: Array<{
    manager: ExecApprovalManager<SystemAgentApprovalRequestPayload>;
    databasePath: string;
  }> = [];
  let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

  beforeAll(() => {
    pluginMetadataSnapshot = createSystemAgentPluginMetadataTestSnapshot(verifiedConfig);
  });

  afterEach(async () => {
    for (const { manager, databasePath } of approvalManagers.splice(0)) {
      await manager.drain();
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
    }
    vi.restoreAllMocks();
    vi.resetAllMocks();
    resetPluginStateStoreForTests();
    resetCommandQueueStateForTest();
    vi.unstubAllEnvs();

    systemAgentTempDirs.cleanup();
  });

  async function createDelegatedChatFixture(
    scheduler: GatewayScheduler,
    source: "typed" | "model tool" | "repair" = "typed",
    previousRun = "live",
  ) {
    const stateDir = systemAgentTempDirs.make("openclaw-full-access-change-");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(verifiedConfig));

    const fixture = await pluginMetadataSnapshot!.run(() =>
      createSystemAgentVerifiedInferenceTestFixture(verifiedConfig),
    );
    setupInferenceMocks.resolvePersistentApplyInference.mockResolvedValue(
      fixture.binding.execution,
    );
    vi.mocked(runConfigSetCommand).mockReset().mockResolvedValue(undefined);
    let proposed = false;
    const engine = new SystemAgentChatEngine({
      operatorApprovalOnly: true,
      surface: "gateway",
      verifiedInference: fixture.binding,
      deps: {
        readConfigFileSnapshot: async () =>
          ({
            exists: true,
            valid: true,
            path: "/tmp/openclaw.json",
            hash: "verified-config",
            config: verifiedConfig,
            runtimeConfig: verifiedConfig,
            sourceConfig: verifiedConfig,
            issues: [],
          }) as never,
      },
      runAgentTurn: async (params) => {
        if (source === "typed" || (proposed && source !== "repair")) {
          return { text: "Config verified." };
        }
        proposed = true;
        const tool = createSystemAgentTool({
          surface: params.surface,
          approvalArmed: params.approvalArmed,
          operatorApprovalOnly: params.operatorApprovalOnly,
          proposalRef: params.session.proposalRef,
        });
        await tool.execute("propose-config", {
          action: "config_set",
          path: source === "repair" ? "gateway.port" : "logging.level",
          value: source === "repair" ? "18789" : "debug",
        });
        return { text: "Change proposed." };
      },
    });
    const delegatedSession: SystemAgentChatSession = {
      engine,
      welcome: "welcome text",
      lastUsedAt: 1,
      ownerKey: JSON.stringify(["main", "agent:main:main"]),
    };
    const sessions = new Map<string, SystemAgentChatSession>([["delegate-full", delegatedSession]]);
    const approvalDatabasePath = path.join(stateDir, "approvals.sqlite");
    if (previousRun === "registration-failure") {
      fs.mkdirSync(approvalDatabasePath);
    }
    const manager = new ExecApprovalManager<SystemAgentApprovalRequestPayload>({
      scheduler,
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
      persistence: {
        runtimeEpoch: "delegated-approval-test",
        databaseOptions: { path: approvalDatabasePath },
      },
    });
    approvalManagers.push({ manager, databasePath: approvalDatabasePath });
    const operationalRunInstance = createOperationalRunInstanceRef("delegated-full-run");
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    const requested = createDeferred();
    const broadcast = vi.fn((event: string) => {
      if (event === "openclaw.approval.requested") {
        requested.resolve();
      }
    });
    const context = {
      systemAgentSessions: sessions,
      systemAgentApprovalManager: manager,
      broadcast,
      broadcastToConnIds: vi.fn(),
      hasExecApprovalClients: () => true,
    } as unknown as GatewayRequestContext;
    const invokeChat = async (message: string) => {
      const respond = vi.fn<(ok: boolean, payload?: unknown, error?: unknown) => void>();
      const handler = expectDefined(systemAgentHandlers["openclaw.chat"], "chat handler");
      await pluginMetadataSnapshot!.run(() =>
        handler({
          params: { sessionId: "delegate-full", message, delegation },
          respond,
          context,
          client: {
            connId: "conn-test",
            connect: { device: { id: "device-test" } },
          } as GatewayClient,
        } as never),
      );
      const [ok, payload, error] = expectDefined(respond.mock.calls[0], "chat response");
      return { ok, payload, error };
    };
    const callChat = (
      message: string,
      overrides: Partial<Caller> = {},
      observation?: AsyncWorkScope,
    ) =>
      withGatewayToolCallerIdentity({ ...delegation, operationalRunInstance, ...overrides }, () =>
        observation ? observation.track(() => invokeChat(message)) : invokeChat(message),
      );
    return {
      engine,
      manager,
      authority,
      delegatedSession,
      runConfigSet: vi.mocked(runConfigSetCommand),
      broadcast,
      callChat,
      requested,
      readApproval: (id: string) =>
        getOperatorApprovalDetailed({ id, databaseOptions: { path: approvalDatabasePath } }),
      expectRequests: (count: number) =>
        expect(
          broadcast.mock.calls.filter(([event]) => event === "openclaw.approval.requested"),
        ).toHaveLength(count),
    };
  }

  it.each([
    "apply",
    "closed-before",
    "closed-after",
    "tool-cancelled",
    "denied",
    "failed-correction",
  ] as const)("settles a separately approved correction with outcome %s", async (outcome) => {
    const fixture = await createDelegatedChatFixture(createTestGatewayScheduler(), "repair");
    fixture.runConfigSet.mockRejectedValueOnce(
      new Error(
        "Config validation failed: gateway.port: Invalid input: expected number, received string",
      ),
    );
    if (outcome === "failed-correction") {
      fixture.runConfigSet.mockRejectedValue(new Error("fixture correction failed"));
    }
    if (outcome === "closed-before") {
      const resolve = fixture.engine.resolveOperatorApproval.bind(fixture.engine);
      vi.spyOn(fixture.engine, "resolveOperatorApproval").mockImplementationOnce(
        async (...args) => {
          const reply = await resolve(...args);
          releaseAgentRunDelegatedAuthority(fixture.authority);
          return reply;
        },
      );
    }
    const controller = new AbortController();
    let settled = false;
    const pending = fixture
      .callChat("config set gateway.port banana", {
        approvalSignals: [controller.signal],
      })
      .then((reply) => {
        settled = true;
        return reply;
      });
    try {
      await fixture.requested.promise;
      const original = expectDefined(
        (await fixture.manager.listPendingRecords())[0],
        "original approval",
      );
      const correctionRequested = createDeferred();
      fixture.broadcast.mockImplementation((event) => {
        if (event === "openclaw.approval.requested") {
          correctionRequested.resolve();
        }
      });
      expect(fixture.runConfigSet).not.toHaveBeenCalled();
      expect(await fixture.manager.resolve(original.id, "allow-once", "operator")).toBe(true);
      if (outcome === "closed-before") {
        await pending;
        expect(await fixture.manager.listPendingRecords()).toEqual([]);
        expect(fixture.engine.getPendingOperatorProposal()).toBeNull();
        expect(fixture.runConfigSet).toHaveBeenCalledOnce();
        fixture.expectRequests(1);
        return;
      }
      expect(
        await Promise.race([
          correctionRequested.promise.then(() => "requested"),
          pending.then(() => "completed"),
        ]),
      ).toBe("requested");
      const correction = expectDefined(
        (await fixture.manager.listPendingRecords())[0],
        "corrective approval",
      );
      fixture.expectRequests(2);
      expect(correction.id).not.toBe(original.id);
      expect(correction.request.proposalHash).not.toBe(original.request.proposalHash);
      await runSystemAgentGatewayTask(async () => undefined);
      expect(settled).toBe(false);
      expect(fixture.runConfigSet).toHaveBeenCalledOnce();
      expect(await fixture.manager.resolve(original.id, "allow-once", "stale-operator")).toBe(
        false,
      );
      if (outcome === "closed-after" || outcome === "tool-cancelled" || outcome === "denied") {
        if (outcome === "closed-after") {
          releaseAgentRunDelegatedAuthority(fixture.authority);
          await fixture.manager.forceDenyIfRuntimeAuthorityClosed(correction.id);
        } else if (outcome === "tool-cancelled") {
          controller.abort();
        } else {
          expect(await fixture.manager.resolve(correction.id, "deny", "operator")).toBe(true);
        }
        expect((await pending).payload).toMatchObject({
          reply: expect.stringContaining(outcome === "denied" ? "Denied" : "cancelled"),
        });
        expect(fixture.runConfigSet).toHaveBeenCalledOnce();
        expect(fixture.engine.getPendingOperatorProposal()).toBeNull();
        expect(await fixture.manager.listPendingRecords()).toEqual([]);
        return;
      }
      expect(await fixture.manager.resolve(correction.id, "allow-once", "operator")).toBe(true);
      const result = await pending;
      expectReplyParts(result.payload, "gateway.port: Invalid input");
      if (outcome === "failed-correction") {
        expectReplyParts(result.payload, "stopped after one corrective attempt");
        fixture.expectRequests(2);
      }
      expect(fixture.runConfigSet).toHaveBeenCalledTimes(2);
      expect(fixture.runConfigSet).toHaveBeenLastCalledWith({
        path: "gateway.port",
        value: "18789",
        cliOptions: {},
        beforePersistentApply: expect.any(Function),
        runtime: expect.objectContaining({ log: expect.any(Function) }),
        throwOnError: false,
      });
      expect(fixture.engine.getPendingOperatorProposal()).toBeNull();
    } finally {
      for (const record of await fixture.manager.listPendingRecords()) {
        await fixture.manager.resolve(record.id, "deny", "cleanup");
      }
      await pending;
    }
  });

  it.each([false, true])(
    "bounds Full Access repair when the correction fails=%s",
    async (fails) => {
      const fixture = await createDelegatedChatFixture(createTestGatewayScheduler(), "repair");
      fixture.runConfigSet.mockRejectedValueOnce(
        new Error("Config validation failed: fixture write rejected"),
      );
      if (fails) {
        fixture.runConfigSet.mockRejectedValue(new Error("fixture correction failed"));
      }
      const reply = await fixture.callChat("config set gateway.port banana", {
        fullPermission: true,
      });
      expect(fixture.runConfigSet).toHaveBeenCalledTimes(2);
      expect(await fixture.manager.listPendingRecords()).toEqual([]);
      expect(fixture.engine.getPendingOperatorProposal()).toBeNull();
      expect(reply.payload).toMatchObject({
        reply: expect.stringContaining(
          fails ? "stopped after one corrective attempt" : "[openclaw] done: config.set",
        ),
      });
    },
  );

  it.each([
    ["allow", "[openclaw] done: config.set", 1, []],
    ["deny", "Denied", 0, []],
    ["expired", "expired", 0, expiredGuidance],
    ["run-cancelled", "cancelled", 0, cancelledGuidance],
    ["tool-cancelled", "cancelled", 0, cancelledGuidance],
    ["apply-failed", "failed", 1, failedGuidance],
    ["queued-cancelled", "cancelled", 0, cancelledGuidance],
    ["precommit-cancelled", "cancelled", 0, cancelledGuidance],
    ["afterDecision-failed", "failed", 0, failedGuidance],
    ["gateway-close", "", 0, []],
  ] as const)(
    "keeps delegated chat pending without blocking other work until %s settles",
    async (outcome, expected, writes, guidance) => {
      const fixture = await createDelegatedChatFixture(
        createTestGatewayScheduler(outcome === "expired" ? "fake-timers" : undefined),
        "typed",
        "durable",
      );
      const controller = new AbortController();
      const observation = new AsyncWorkScope();
      if (outcome === "expired") {
        vi.useFakeTimers();
        installTestApprovalClock();
      }
      const applyStarted = createDeferred();
      const releaseApply = createDeferred();
      const historyStarted = createDeferred();
      const releaseHistory = createDeferred();
      const execution = await setupInferenceMocks.resolvePersistentApplyInference();
      if (outcome === "precommit-cancelled" || outcome === "afterDecision-failed") {
        setupInferenceMocks.resolvePersistentApplyInference.mockImplementationOnce(async () => {
          applyStarted.resolve();
          await releaseApply.promise;
          if (outcome === "afterDecision-failed") {
            throw new Error("inference unavailable");
          }
          return execution;
        });
      }
      if (outcome === "apply-failed") {
        fixture.runConfigSet.mockRejectedValueOnce(new Error("write failed"));
      }
      let sameOwner: Promise<Awaited<ReturnType<typeof fixture.callChat>>> | undefined;
      let settled = false;
      const pending = fixture
        .callChat(
          "config set logging.level debug",
          { approvalSignals: [controller.signal] },
          observation,
        )
        .then((result) => {
          settled = true;
          return result;
        });
      try {
        await fixture.requested.promise;
        const record = expectDefined(
          (await fixture.manager.listPendingRecords())[0],
          "pending approval",
        );
        await runSystemAgentGatewayTask(async () => undefined);
        expect.soft(settled).toBe(false);
        expect(fixture.runConfigSet).not.toHaveBeenCalled();
        if (outcome === "gateway-close") {
          const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
          observation.beginClose();
          await rejected;
          await observation.drain();
          expect(await fixture.readApproval(record.id)).toMatchObject({
            outcome: "found",
            record: { status: "pending" },
          });
          expect(fixture.engine.getPendingOperatorProposal()).not.toBeNull();
          expect(fixture.runConfigSet).not.toHaveBeenCalled();
          return;
        }
        if (outcome === "allow") {
          sameOwner = fixture.callChat("Has it finished?");
          await runSystemAgentGatewayTask(async () => undefined);
          expect(await fixture.manager.listPendingRecords()).toHaveLength(1);
          // Both proposal observers have released the task queue; gate only terminal persistence.
          transcriptStoreMocks.appendTurn.mockImplementation(async () => {
            historyStarted.resolve();
            await releaseHistory.promise;
          });
        }
        if (outcome === "expired") {
          await vi.advanceTimersByTimeAsync(SYSTEM_AGENT_APPROVAL_TIMEOUT_MS);
        } else if (outcome === "run-cancelled") {
          releaseAgentRunDelegatedAuthority(fixture.authority);
          await fixture.manager.forceDenyIfRuntimeAuthorityClosed(record.id);
        } else if (outcome === "tool-cancelled") {
          controller.abort();
        } else {
          const queued =
            outcome === "queued-cancelled"
              ? runSystemAgentGatewayTask(async () => {
                  applyStarted.resolve();
                  await releaseApply.promise;
                })
              : undefined;
          if (queued) {
            await applyStarted.promise;
          }
          expect(
            await fixture.manager.resolve(
              record.id,
              outcome === "deny" ? "deny" : "allow-once",
              "operator-ui",
            ),
          ).toBe(true);
          if (queued || outcome === "precommit-cancelled" || outcome === "afterDecision-failed") {
            await applyStarted.promise;
            if (outcome !== "afterDecision-failed") {
              controller.abort();
            }
            releaseApply.resolve();
            await queued;
          }
        }
        if (outcome === "allow") {
          await awaitGateBeforeSettlement(
            historyStarted.promise,
            pending,
            "approval completed before history persistence",
          );
          expect(settled).toBe(false);
          releaseHistory.resolve();
        }
        const result = await pending;
        if (sameOwner) {
          expect((await sameOwner).payload).toEqual(result.payload);
        }
        if (outcome === "queued-cancelled" || outcome === "precommit-cancelled") {
          expect(await fixture.readApproval(record.id)).toMatchObject({
            outcome: "found",
            record: { decision: "allow-once", status: "allowed" },
          });
          expect(await fixture.manager.resolve(record.id, "allow-once", "late-operator")).toBe(
            false,
          );
        }
        expect.soft(result.payload).toMatchObject({ reply: expect.stringContaining(expected) });
        expectReplyParts(result.payload, ...guidance);
        expect.soft(result.payload).not.toHaveProperty("needsApproval");
        expect.soft(result.payload).not.toHaveProperty("proposalId");
        await vi.waitFor(() => expect(fixture.engine.getPendingOperatorProposal()).toBeNull());
        expect(fixture.runConfigSet).toHaveBeenCalledTimes(writes);
        if (outcome === "allow" || outcome === "afterDecision-failed") {
          expect(
            transcriptStoreMocks.appendTurn.mock.calls.filter(([turn]) =>
              turn.text.includes(
                outcome === "allow" ? "[openclaw] done: config.set" : "failed to complete",
              ),
            ),
          ).toHaveLength(1);
        }
      } finally {
        releaseHistory.resolve();
        releaseApply.resolve();
        controller.abort();
        for (const record of await fixture.manager.listPendingRecords()) {
          await fixture.manager.expire(record.id);
        }
        await Promise.allSettled([pending]);
        await sameOwner;
        await fixture.manager.drain();
        await observation.drain();
        await fixture.engine.dispose();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ...(["typed", "model tool"] as const).flatMap((source) =>
      (["closed", "live", "live-restricted"] as const).map((previousRun) => ({
        source,
        previousRun,
      })),
    ),
    { source: "typed" as const, previousRun: "storage-failure" as const },
    { source: "typed" as const, previousRun: "unregistered-closed" as const },
    { source: "typed" as const, previousRun: "registration-failure" as const },
  ])(
    "applies Full Access via $source without inheriting a $previousRun proposal",
    async ({ source, previousRun }) => {
      const fixture = await createDelegatedChatFixture(
        createTestGatewayScheduler(),
        source,
        previousRun,
      );

      const call = await fixture.callChat(
        source === "typed" ? "config set logging.level debug" : "Change the logging level.",
        { fullPermission: true },
      );

      expect(call.error).toBeUndefined();
      expect(call).toMatchObject({
        ok: true,
        payload: { reply: expect.stringContaining("[openclaw] done: config.set") },
      });
      expect(fixture.runConfigSet).toHaveBeenCalledOnce();
      expect(call.payload).not.toHaveProperty("needsApproval");
      expect(call.payload).not.toHaveProperty("proposalId");
      expect(await fixture.manager.listPendingRecords()).toEqual([]);
      expect(fixture.broadcast).not.toHaveBeenCalled();
      expect(fixture.engine.getPendingOperatorProposal()).toBeNull();
      expect(readLastSystemAgentAuditEntry()).toMatchObject({
        operation: "config.set",
        summary: "Set config logging.level",
      });
      expect(transcriptStoreMocks.appendTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "assistant",
          text: expect.stringContaining("[openclaw] done: config.set"),
        }),
      );

      if (previousRun === "unregistered-closed") {
        const handle = fixture.engine.handle.bind(fixture.engine);
        vi.spyOn(fixture.engine, "handle").mockImplementationOnce(async (...args) => {
          const reply = await handle(...args);
          // Close the real requesting run after staging, before the Gateway resolves its proposal.
          expect(fixture.engine.getPendingOperatorProposal()?.operation).toEqual({
            kind: "config-set",
            path: "logging.level",
            value: "info",
          });
          expect(releaseAgentRunDelegatedAuthority(fixture.authority)).toBe(true);
          return reply;
        });
      }
      const proposalCall = fixture.callChat("config set logging.level info", {
        fullPermission: previousRun === "unregistered-closed",
      });
      if (previousRun === "unregistered-closed" || previousRun === "registration-failure") {
        await expect(proposalCall).rejects.toThrow(
          previousRun === "unregistered-closed"
            ? "system-agent approval authority is no longer active"
            : "SQLite worker database path must identify a regular file",
        );
        expect.soft(fixture.delegatedSession.pendingApproval).toBeUndefined();
        expect(await fixture.manager.listPendingRecords()).toEqual([]);
        expect.soft(fixture.engine.getPendingOperatorProposal()).toBeNull();
      } else {
        await fixture.requested.promise;
        expect(await fixture.manager.listPendingRecords()).toHaveLength(1);
      }
      expect(fixture.runConfigSet).toHaveBeenCalledOnce();
      const pending = (await fixture.manager.listPendingRecords())[0];
      if (previousRun === "closed") {
        releaseAgentRunDelegatedAuthority(fixture.authority);
        const pendingId = expectDefined(pending, "restricted proposal").id;
        await fixture.manager.forceDenyIfRuntimeAuthorityClosed(pendingId);
        expect((await fixture.manager.getSnapshot(pendingId))?.status).toBe("cancelled");
      }

      const replacementRun = createOperationalRunInstanceRef("delegated-replacement-run");
      const replacementAuthority = claimAgentRunDelegatedAuthority(replacementRun);
      const previousAuthorityActive =
        previousRun !== "closed" && previousRun !== "unregistered-closed";
      expect(validateAgentRunDelegatedAuthority(fixture.authority)).toBe(previousAuthorityActive);
      expect(validateAgentRunDelegatedAuthority(replacementAuthority)).toBe(true);
      const readOnly = () =>
        fixture.callChat("config get logging.level", {
          operationalRunInstance: replacementRun,
          fullPermission: previousRun !== "live-restricted",
        });
      if (previousRun === "storage-failure") {
        const forceDeny = fixture.manager.forceDenyIfRuntimeAuthorityClosed.bind(fixture.manager);
        const storageFailure = vi
          .spyOn(fixture.manager, "forceDenyIfRuntimeAuthorityClosed")
          .mockImplementation(async (id) => {
            if (!fixture.delegatedSession.pendingApproval) {
              await fixture.manager.forceDenyDetailed(id, "storage-corrupt", {
                kind: "system",
                id: null,
              });
              throw new Error("approval storage unavailable");
            }
            return forceDeny(id);
          });
        await expect(readOnly()).rejects.toThrow("approval storage unavailable");
        expect(fixture.engine.getPendingOperatorProposal()).toBeNull();
        storageFailure.mockRestore();
      }
      const readOnlyReply = await readOnly();
      expect(readOnlyReply.error).toBeUndefined();
      expect.soft(fixture.runConfigSet).toHaveBeenCalledOnce();
      expectReplyParts(readOnlyReply.payload, "logging.level: not set");
      expect(fixture.engine.getPendingOperatorProposal()).toBeNull();
      expect(await fixture.manager.listPendingRecords()).toEqual([]);
      if (pending) {
        expect(await fixture.manager.resolve(pending.id, "allow-once", "late-operator")).toBe(
          false,
        );
        expectReplyParts((await proposalCall).payload, "cancelled");
      }
      expect(validateAgentRunDelegatedAuthority(fixture.authority)).toBe(previousAuthorityActive);
    },
  );
});
