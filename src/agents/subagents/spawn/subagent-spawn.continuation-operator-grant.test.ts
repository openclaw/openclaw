import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runContinuationCustodyBoot } from "../../../auto-reply/continuation/custody-boot.js";
import {
  createContinuationRecord,
  hydrateContinuationCustody,
  listContinuationRecords,
  newContinuationRecordId,
} from "../../../auto-reply/continuation/custody/custody-store.js";
import {
  dispatchToolDelegates,
  resetDelegateDispatchHedgesForTests,
} from "../../../auto-reply/continuation/delegate-dispatch.js";
import { resetContinueDelegateTurnAdmissionForTests } from "../../../auto-reply/continuation/delegate-turn-admission.js";
import { captureContinuationQueueContext } from "../../../auto-reply/continuation/queue-context.js";
import { resetContinuationStateForTests } from "../../../auto-reply/continuation/state.js";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../../config/config.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { invalidateGatewayDeviceRevocation } from "../../../gateway/device-revocation.js";
import {
  createOperatorRecoveryFixture,
  pairedOperator,
  persistDevices,
} from "../../../gateway/operator-run-recovery.test-support.js";
import type { GatewayLifecycleRuntime } from "../../../gateway/server-instance-runtime.types.js";
import type {
  GatewayClient,
  GatewayRequestContext,
} from "../../../gateway/server-methods/shared-types.js";
import { createContext } from "../../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { loadPendingSessionDeliveries } from "../../../infra/session-delivery-queue-storage.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../../infra/system-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { createTestRegistry } from "../../../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import {
  configureMockSubagentRegistryPersistence,
  type MockSubagentRegistryRows,
} from "../../subagent-test-fixtures.test-helpers.js";
import { createContinueDelegateTool } from "../../tools/continue-delegate-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { restoreSubagentRunsFromDisk } from "../registry/subagent-registry-persistence.js";
import { resetSubagentRegistryForTests } from "../registry/subagent-registry.test-helpers.js";
import "./subagent-spawn-model.mocks.shared.js";
import { testing as subagentSpawnTesting } from "./subagent-spawn.test-support.js";

// mock-isolation: In-process spawn tests supply registries without loading installed plugins.
vi.mock("../../runtime-plugins.js", () => {
  const loadRegistry =
    vi.fn<typeof import("../../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle>();
  return {
    loadAgentRuntimePluginRegistryHandle: loadRegistry,
    loadAgentRuntimePluginRegistryHandleAsync: async (...args: Parameters<typeof loadRegistry>) =>
      loadRegistry(...args),
  };
});
vi.mock("../registry/subagent-registry-state.js", { spy: true });
vi.mock("../registry/subagent-registry-persistence.js", { spy: true });

const OWNER = "agent:main:main";
const OTHER = "agent:main:other";
const INTERRUPTED_NOTICE = "[continuation:delegate-spawn-interrupted]";
const CHILD_RESULT = "the crane is folded";
const envSnapshot = captureEnv(["OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR"]);
const persistRegistryRows = vi.fn<MockSubagentRegistryRows>();
let stateDir = "";

type ChildLaunch = { sessionKey: string; client: GatewayClient };

function runtimeConfig(): OpenClawConfig {
  return {
    session: { mainKey: "main", scope: "per-sender" },
    agents: {
      defaults: {
        workspace: stateDir,
        continuation: { enabled: true, minDelayMs: 50, defaultDelayMs: 50 },
      },
      entries: { main: { workspace: stateDir } },
    },
  };
}

/** The Gateway instance: real in-process dispatch; only the child turn itself is recorded. */
function gatewayInstance(config: OpenClawConfig) {
  const launches: ChildLaunch[] = [];
  const context: GatewayRequestContext = createContext([], () => config);
  context.resolveGatewayContext = () => context;
  context.createAgentTurnFacade = ({ client }) => ({
    dispatch: async <T>(request: { sessionKey?: string; idempotencyKey?: string }) => {
      launches.push({ sessionKey: expectDefined(request.sessionKey, "child key"), client });
      return { runId: request.idempotencyKey, status: "accepted" } as T;
    },
    dispatchRaw: async () => {
      throw new Error("unexpected raw child dispatch");
    },
    wait: async () => {
      throw new Error("unexpected child wait");
    },
  });
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected Gateway lifecycle call");
  };
  // Each child finishes its task at once; the registry returns its result to the requester.
  context.lifecycleRuntime = {
    waitForAgent: async <T>() =>
      ({
        status: "ok",
        startedAt: Date.now(),
        endedAt: Date.now(),
        terminalReply: { disposition: "visible", text: CHILD_RESULT },
      }) as T,
    dispatchAgent: unexpected,
    dispatchSessionMethod: unexpected,
    sendNotice: unexpected,
  } satisfies GatewayLifecycleRuntime;
  return { context, launches };
}

/** The request scope a turn runs in: a Gateway operator connection, or an internal caller. */
function turnScope(gateway: ReturnType<typeof gatewayInstance>, client?: GatewayClient) {
  let connected = true;
  const scope = {
    context: gateway.context,
    resolveGatewayContext: gateway.context.resolveGatewayContext,
    ...(client
      ? { client, hasCurrentClientAuthority: () => connected && !client.invalidated }
      : {}),
    isWebchatConnect: () => false,
  };
  return {
    /** The electing turn: the tool accepts the delegate, then its post-response dispatch runs. */
    elect: (delaySeconds: number) =>
      withPluginRuntimeGatewayRequestScope(scope, () => electDelegate(delaySeconds)),
    dispatch: (sessionKey: string) =>
      withPluginRuntimeGatewayRequestScope(scope, () => dispatchQueued(sessionKey)),
    disconnect: () => {
      connected = false;
    },
  };
}

/** A CLI operator connection (k6, `openclaw agent`) electing delegates in its own turn. */
async function operatorConnection(gateway: ReturnType<typeof gatewayInstance>, scopes: string[]) {
  const profile = ensureProfileForEmail("elector@example.test");
  const device = pairedOperator();
  const fixture = await createOperatorRecoveryFixture({
    stateDir,
    context: gateway.context,
    profileId: profile.id,
    config: runtimeConfig(),
    device,
    scopes,
    sourceIngress: "internal",
  });
  // The handshake binds access policy: none configured, so no plugin grant (null).
  fixture.client.internal = { ...fixture.client.internal, operatorAccessAuthority: null };
  return { profileId: profile.id, device, ...turnScope(gateway, fixture.client) };
}

async function electDelegate(delaySeconds: number): Promise<string> {
  const tool = createContinueDelegateTool({ agentSessionKey: OWNER, runId: "electing-run" });
  const accepted = await tool.execute("call-1", { task: "fold the next crane", delaySeconds });
  expect(accepted.details).toMatchObject({ status: "scheduled" });
  const [record] = await listContinuationRecords({ ownerSessionKey: OWNER, kinds: ["delegate"] });
  await dispatchQueued(OWNER);
  return expectDefined(record, "elected delegate record").recordId;
}

async function dispatchQueued(sessionKey: string) {
  await dispatchToolDelegates({
    sessionKey,
    chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
    ctx: { sessionKey },
    maxChainLength: 10,
  });
}

function expectChildUnderElector(launch: ChildLaunch | undefined, profileId: string) {
  const authority = launch?.client.internal?.operatorRunAuthority;
  expect(authority?.profileId).toBe(profileId);
  expect(authority?.scopes).toEqual(["operator.write"]);
  expect(launch?.client.connect.scopes).not.toContain("operator.admin");
}

async function settledDelegate(recordId: string) {
  return await vi.waitFor(
    async () => {
      const [record] = await listContinuationRecords({ recordIds: [recordId] });
      expect(record?.status).toMatch(/^(succeeded|failed|cancelled)$/);
      return expectDefined(record, "settled delegate record");
    },
    { timeout: 10_000, interval: 20 },
  );
}

/** The children's results delivered back to the owner session, once each settles. */
async function expectReturnsToOwner(count: number) {
  await vi.waitFor(
    async () => {
      const deliveries = await loadPendingSessionDeliveries(captureContinuationQueueContext());
      const returns = deliveries.filter(
        (entry) =>
          entry.sessionKey === OWNER &&
          entry.kind === "systemEvent" &&
          entry.text.includes(CHILD_RESULT),
      );
      expect(returns).toHaveLength(count);
    },
    { timeout: 10_000, interval: 20 },
  );
}

async function interruptedNotices(): Promise<string[]> {
  return (await loadPendingSessionDeliveries(captureContinuationQueueContext())).flatMap((entry) =>
    entry.kind === "systemEvent" && entry.text.includes(INTERRUPTED_NOTICE) ? [entry.text] : [],
  );
}

async function delegateRecords(sessionKey: string) {
  return await listContinuationRecords({ ownerSessionKey: sessionKey, kinds: ["delegate"] });
}

/** Fail closed: a named terminal refusal, no child, no interrupted-spawn notice. */
async function expectRefused(
  gateway: ReturnType<typeof gatewayInstance>,
  recordId: string,
  reason: RegExp,
) {
  const record = await settledDelegate(recordId);
  expect(record.status).toBe("failed");
  expect(record.failureReason).toMatch(reason);
  expect(gateway.launches).toEqual([]);
  expect(await interruptedNotices()).toEqual([]);
}

async function configure(cfg: OpenClawConfig) {
  await writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(cfg));
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await captureRuntimeConfigAsyncReader()();
}

describe("continuation delegate dispatch under the elector's bounded grant", () => {
  beforeEach(async () => {
    resetGatewayWorkAdmission();
    await resetSubagentRegistryForTests({ persist: false });
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReturnValue(createTestRegistry([]));
    persistRegistryRows.mockReset();
    await configureMockSubagentRegistryPersistence({ persistRegistryRows });
    vi.mocked(restoreSubagentRunsFromDisk).mockResolvedValue(0);
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-delegate-grant-"));
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    setTestEnvValue("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await configure(runtimeConfig());
    await hydrateContinuationCustody();
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: OWNER },
      { sessionId: "owner-session", updatedAt: Date.now() },
    );
  });

  afterEach(async () => {
    vi.useRealTimers();
    subagentSpawnTesting.setDepsForTest();
    resetDelegateDispatchHedgesForTests();
    resetContinueDelegateTurnAdmissionForTests();
    resetContinuationStateForTests();
    resetSystemEventsForTest();
    resetGatewayWorkAdmission();
    await resetSubagentRegistryForTests({ persist: false });
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
    vi.mocked(restoreSubagentRunsFromDisk).mockReset();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    await cleanupSessionStateForTest({ stateDir });
    await closeOpenClawStateDatabaseAsync();
    envSnapshot.restore();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = "";
    }
  });

  it("spawns a timed delegate after its operator's connection closes", async () => {
    const gateway = gatewayInstance(runtimeConfig());
    const operator = await operatorConnection(gateway, ["operator.write"]);
    const recordId = await operator.elect(0.05);
    operator.disconnect();

    const record = await settledDelegate(recordId);

    expect(record).toMatchObject({ status: "succeeded", handoff: { target: "subagent_runs" } });
    expect(gateway.launches).toHaveLength(1);
    expectChildUnderElector(gateway.launches[0], operator.profileId);
    const childRunId = record.handoff?.target === "subagent_runs" ? record.handoff.childRunId : "";
    expect(subagentRuns.get(childRunId)).toMatchObject({
      requesterSessionKey: OWNER,
      childSessionKey: gateway.launches[0]!.sessionKey,
    });
    await expectReturnsToOwner(1);
    expect(await delegateRecords(OWNER)).toHaveLength(1);
    expect(await interruptedNotices()).toEqual([]);
    expect(peekSystemEvents(OWNER).filter((text) => text.includes("DELEGATE spawn"))).toEqual([]);
  });

  it("refuses a timed delegate whose operator device was revoked before it fired", async () => {
    const gateway = gatewayInstance(runtimeConfig());
    const operator = await operatorConnection(gateway, ["operator.write"]);
    const recordId = await operator.elect(0.05);
    persistDevices(stateDir, [], "both");
    invalidateGatewayDeviceRevocation(gateway.context, operator.device.deviceId, "operator");
    operator.disconnect();

    await expectRefused(gateway, recordId, /operator dispatch grant was revoked/);
  });

  it("refuses when the operator's scopes narrow below the grant, connection still open", async () => {
    const gateway = gatewayInstance(runtimeConfig());
    const operator = await operatorConnection(gateway, ["operator.write"]);
    const recordId = await operator.elect(0.05);
    const narrowed = structuredClone(operator.device);
    narrowed.tokens!.operator!.scopes = ["operator.read"];
    persistDevices(stateDir, [narrowed], "both");

    await expectRefused(gateway, recordId, /operator dispatch grant was revoked/);
  });

  it("never lets a grant authorize a spawn under another session", async () => {
    const gateway = gatewayInstance(runtimeConfig());
    const operator = await operatorConnection(gateway, ["operator.write"]);
    const elected = await operator.elect(60);
    resetDelegateDispatchHedgesForTests();
    const [source] = await listContinuationRecords({ recordIds: [elected] });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: OTHER },
      { sessionId: "other-session", updatedAt: Date.now() },
    );
    const copiedId = newContinuationRecordId();
    const copied = await createContinuationRecord({
      recordId: copiedId,
      kind: "delegate",
      ownerSessionKey: OTHER,
      status: "queued",
      createdAt: Date.now(),
      dueAt: Date.now(),
      stateJson: expectDefined(source, "elected record").stateJson.replace(/"delayMs":\d+,/, ""),
    });
    expect(copied.outcome).toBe("created");
    await operator.dispatch(OTHER);

    await expectRefused(gateway, copiedId, /belongs to another session/);
  });

  it("refuses an expired grant even while the electing connection is open", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const gateway = gatewayInstance(runtimeConfig());
    const operator = await operatorConnection(gateway, ["operator.write"]);
    const recordId = await operator.elect(0.05);
    // Past the due time plus the grant's one-hour slack.
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);

    await expectRefused(gateway, recordId, /operator dispatch grant expired/);
  });

  it("keeps the grant across a Gateway restart and never spawns through an ambient route", async () => {
    const ambient: unknown[] = [];
    subagentSpawnTesting.setDepsForTest({
      callGateway: async <T>(request: { method: string; params?: unknown }) => {
        ambient.push(request.method);
        return { status: "accepted", runId: "ambient-child" } as T;
      },
    });
    const before = gatewayInstance(runtimeConfig());
    const operator = await operatorConnection(before, ["operator.write"]);
    const recordId = await operator.elect(0.3);
    // The process dies: its timers, its connection and its Gateway instance go with it.
    resetDelegateDispatchHedgesForTests();
    operator.disconnect();
    const after = gatewayInstance(runtimeConfig());

    await runContinuationCustodyBoot({
      armedAt: Date.now(),
      resolveGatewayContext: after.context.resolveGatewayContext,
      whenSubagentRegistryActivated: async () => {},
    });
    const record = await settledDelegate(recordId);

    expect(ambient).toEqual([]);
    expect(record.status).toBe("succeeded");
    expect(before.launches).toEqual([]);
    expect(after.launches).toHaveLength(1);
    expectChildUnderElector(after.launches[0], operator.profileId);
    await expectReturnsToOwner(1);
    expect(await interruptedNotices()).toEqual([]);
  });

  it("leaves internal-caller (channel) and immediate operator delegates as they were", async () => {
    const gateway = gatewayInstance(runtimeConfig());
    const channelTurn = turnScope(gateway);
    const channelRecord = await settledDelegate(await channelTurn.elect(0.05));
    const operator = await operatorConnection(gateway, ["operator.write"]);
    const immediateRecord = await settledDelegate(await operator.elect(0));

    expect([channelRecord.status, immediateRecord.status]).toEqual(["succeeded", "succeeded"]);
    expect(channelRecord.stateJson).not.toContain("dispatchGrant");
    expect(gateway.launches).toHaveLength(2);
    expect(gateway.launches[0]!.client.internal?.operatorRunAuthority).toBeUndefined();
    expectChildUnderElector(gateway.launches[1], operator.profileId);
    await expectReturnsToOwner(2);
    expect(await interruptedNotices()).toEqual([]);
  });
});
