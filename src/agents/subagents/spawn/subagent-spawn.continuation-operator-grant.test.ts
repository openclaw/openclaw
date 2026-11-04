import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateContinuationCustody } from "../../../auto-reply/continuation/custody/custody-store.js";
import { listContinuationRecords } from "../../../auto-reply/continuation/custody/custody-store.js";
import {
  dispatchToolDelegates,
  resetDelegateDispatchHedgesForTests,
} from "../../../auto-reply/continuation/delegate-dispatch.js";
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
const INTERRUPTED_NOTICE = "[continuation:delegate-spawn-interrupted]";
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
  return { context, launches };
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
  let connected = true;
  const scope = {
    context: gateway.context,
    resolveGatewayContext: gateway.context.resolveGatewayContext,
    client: fixture.client,
    hasCurrentClientAuthority: () => connected && !fixture.client.invalidated,
    isWebchatConnect: () => false,
  };
  return {
    profileId: profile.id,
    device,
    /** The electing turn: the tool accepts the delegate, then its post-response dispatch runs. */
    elect: (delaySeconds: number) =>
      withPluginRuntimeGatewayRequestScope(scope, () => electDelegate(delaySeconds)),
    disconnect: () => {
      connected = false;
    },
  };
}

async function electDelegate(delaySeconds: number): Promise<string> {
  const tool = createContinueDelegateTool({ agentSessionKey: OWNER, runId: "electing-run" });
  const accepted = await tool.execute("call-1", { task: "fold the next crane", delaySeconds });
  expect(accepted.details).toMatchObject({ status: "scheduled" });
  const [record] = await listContinuationRecords({ ownerSessionKey: OWNER, kinds: ["delegate"] });
  await dispatchToolDelegates({
    sessionKey: OWNER,
    chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
    ctx: { sessionKey: OWNER },
    maxChainLength: 10,
  });
  return expectDefined(record, "elected delegate record").recordId;
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

async function interruptedNotices(): Promise<string[]> {
  return (await loadPendingSessionDeliveries(captureContinuationQueueContext())).flatMap((entry) =>
    entry.kind === "systemEvent" && entry.text.includes(INTERRUPTED_NOTICE) ? [entry.text] : [],
  );
}

async function delegateRecords() {
  return await listContinuationRecords({ ownerSessionKey: OWNER, kinds: ["delegate"] });
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
    resetDelegateDispatchHedgesForTests();
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
    const child = gateway.launches[0]!;
    expect(child.client.internal?.operatorRunAuthority?.profileId).toBe(operator.profileId);
    expect(child.client.connect.scopes).not.toContain("operator.admin");
    const childRunId = record.handoff?.target === "subagent_runs" ? record.handoff.childRunId : "";
    expect(subagentRuns.get(childRunId)).toMatchObject({
      requesterSessionKey: OWNER,
      childSessionKey: child.sessionKey,
    });
    expect(await delegateRecords()).toHaveLength(1);
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

    const record = await settledDelegate(recordId);

    expect(record.status).toBe("failed");
    expect(record.failureReason).toMatch(/operator dispatch grant .*revoked/i);
    expect(gateway.launches).toEqual([]);
    expect(await interruptedNotices()).toEqual([]);
  });
});
