import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { nodePairingHandlers } from "../gateway/server-methods/nodes.pairing.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { listNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import type { CronStoredJob } from "./types.js";

// The resident profile catalog is the profile requester's owner check; the test
// removes the profile while the tool awaits its pairing list.
const profile = vi.hoisted(() => ({ current: true }));
vi.mock("../state/user-profile-list.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/user-profile-list.js")>()),
  captureResidentUserProfileAccess: (profileId: string) => {
    const assertCurrent = () => {
      if (!profile.current) {
        throw new Error(`profile ${profileId} was removed`);
      }
    };
    assertCurrent();
    return { assertCurrent };
  },
}));

const { createOpenClawCodingToolsInternalAsync } = await import("../agents/agent-tools.js");
const { createAdmittedGatewayToolCallerIdentity, withGatewayToolCallerIdentity } =
  await import("../agents/tools/gateway-caller-context.js");
const { resolveGatewayScopedTools } = await import("../gateway/tool-resolution.js");
const { admitScheduledOccurrence } = await import("./execution-context-admission.js");
const { prepareCronRunAdmission } = await import("./run-admission.js");

const PARENT_KEY = "agent:main:dashboard:parent";
const RUN_KEY = "agent:main:cron:job-1:run:s1";
const CFG: OpenClawConfig = {};

const stored = {
  id: "job-1",
  agentId: "main",
  name: "Approve pairing",
  enabled: true,
  createdAtMs: 0,
  updatedAtMs: 0,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "approve" },
  delivery: { mode: "none" },
  state: {},
  sourceConversation: { sessionKey: PARENT_KEY, sessionId: "parent-session" },
  createdActor: { type: "human", source: "profile", id: "profile-requester" },
} as CronStoredJob;

beforeEach(() => {
  setRuntimeConfigSnapshot(CFG);
  replaceSessionEntrySync(
    { sessionKey: PARENT_KEY },
    { sessionId: "parent-session", lifecycleRevision: "rev-1", updatedAt: Date.now() },
  );
  replaceSessionEntrySync(
    { sessionKey: RUN_KEY },
    { sessionId: "run-session", updatedAt: Date.now() },
  );
});
afterEach(() => {
  profile.current = true;
});

/**
 * Runs `nodes approve` on an admitted scheduled run's embedded tools against the
 * real in-process Gateway dispatch and pairing handlers. `revokeDuringList`
 * removes the requester's owner status inside `node.pair.list`, the await the
 * tool makes before `node.pair.approve`.
 */
async function approveFromScheduledRun(runtime: "embedded" | "cli", revokeDuringList: boolean) {
  // A node device paired at the device layer asks for its node surface.
  const nodeId = `node-${runtime}-${revokeDuringList ? "revoked" : "owner"}`;
  const device = await requestDevicePairing({
    deviceId: nodeId,
    publicKey: `pk-${nodeId}`,
    role: "node",
    roles: ["node"],
    scopes: [],
  });
  await approveDevicePairing(device.request.requestId, { callerScopes: [] });
  const { request } = await requestNodePairing({
    nodeId,
    platform: "macos",
    deviceFamily: "Mac",
  });
  const dispatched: string[] = [];
  const context = createContext([
    [
      "node.pair.list",
      "operator.pairing",
      "nodes",
      async (options) => {
        dispatched.push("node.pair.list");
        await nodePairingHandlers["node.pair.list"]!(options);
        if (revokeDuringList) {
          profile.current = false;
        }
      },
    ],
    [
      "node.pair.approve",
      "operator.pairing",
      "nodes",
      async (options) => {
        dispatched.push("node.pair.approve");
        await nodePairingHandlers["node.pair.approve"]!(options);
      },
    ],
  ]);
  // No node is connected; approval only publishes to Gateway clients.
  Object.assign(context, { nodeRegistry: { get: () => undefined }, broadcast: () => {} });
  const occurrence = await admitScheduledOccurrence({
    cfg: CFG,
    job: stored,
    agentId: "main",
    trigger: "cron",
  });
  const admission = prepareCronRunAdmission({
    cfg: CFG,
    agentId: "main",
    runId: "run-1",
    sessionKey: RUN_KEY,
    jobId: stored.id,
    deliveryAttemptFence: null,
    // The Gateway binds its request context to the admitted run, as cron does.
    resolveGatewayContext: () => context,
    scheduledExecution: occurrence.mint({
      cfg: CFG,
      agentId: "main",
      runId: "run-1",
      runSessionKey: RUN_KEY,
      toolsAllow: ["*"],
    }),
  });
  try {
    const admitted = await admission.preparedRunAdmission.admit("embedded");
    const tools =
      runtime === "embedded"
        ? await createOpenClawCodingToolsInternalAsync({
            config: CFG,
            agentId: "main",
            sessionKey: RUN_KEY,
            sessionId: "run-session",
            runId: "run-1",
            trigger: "cron",
            jobId: stored.id,
            operationalRunInstance: admitted.operationalRunInstance,
            toolConstructionPlan: {
              includeBaseCodingTools: false,
              includeShellTools: false,
              includeChannelTools: false,
              includeOpenClawTools: true,
              includePluginTools: false,
            },
          })
        : (
            await resolveGatewayScopedTools({
              cfg: CFG,
              sessionKey: RUN_KEY,
              sessionId: "run-session",
              runId: "run-1",
              senderIsOwner: false,
              surface: "loopback",
              admittedRunContext: admitted,
              toolsAllow: ["*"],
            })
          ).tools;
    const nodes = tools.find((tool) => tool.name === "nodes");
    if (!nodes) {
      throw new Error("the owner run was not offered nodes");
    }
    // Both runners execute tools under the admitted run's Gateway caller.
    const caller = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: admitted,
      agentId: "main",
      sessionKey: RUN_KEY,
    });
    const outcome = await withGatewayToolCallerIdentity(caller, () =>
      nodes.execute("call", { action: "approve", requestId: request.requestId }),
    ).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    );
    const pairing = await listNodePairing();
    return {
      outcome,
      dispatched,
      stillPending: pairing.pending.some((entry) => entry.requestId === request.requestId),
    };
  } finally {
    admission.close();
    occurrence.release();
  }
}

describe.each(["embedded", "cli"] as const)("%s scheduled run", (runtime) => {
  it("approves a pending node pairing for an owner requester through the Gateway", async () => {
    const run = await approveFromScheduledRun(runtime, false);
    expect(run.outcome.ok).toBe(true);
    expect(run.dispatched).toEqual(["node.pair.list", "node.pair.approve"]);
    expect(run.stillPending).toBe(false);
  });

  it("refuses node.pair.approve when the requester is revoked during node.pair.list", async () => {
    const run = await approveFromScheduledRun(runtime, true);
    expect(run.outcome.ok).toBe(false);
    expect(run.dispatched).toEqual(["node.pair.list"]);
    expect(run.stillPending).toBe(true);
  });
});
