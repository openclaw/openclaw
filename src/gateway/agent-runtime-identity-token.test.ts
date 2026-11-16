import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import {
  claimAgentRunDelegatedAuthority,
  claimAgentRunApprovalAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { runClientCredentialOperation } from "../infra/client-credential-store.js";
import { readExecApprovalsSnapshot } from "../infra/exec-approvals-store.js";
import { testing as execApprovalsStoreTesting } from "../infra/exec-approvals-store.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  readAgentRuntimeExecutionLineage,
  withAgentRuntimeExecutionLineage,
} from "./agent-runtime-execution-lineage.js";
import type {
  AgentRuntimeIdentity,
  AgentRuntimeIdentityTokenParams,
  AgentRuntimeSessionSpawnContext,
} from "./agent-runtime-identity-token.js";

const envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);

const tempHomes: string[] = [];
const reloadedStateDatabaseClosers = new Set<() => void>();

function operationalRun(runId = "run-1") {
  const operationalRunInstance = { instanceId: `instance-${runId}`, runId } as const;
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  return { operationalRunInstance, delegatedAuthority };
}

function runtimeParams(
  overrides: Partial<AgentRuntimeIdentityTokenParams> = {},
  run = operationalRun(),
): AgentRuntimeIdentityTokenParams {
  return {
    ...run,
    agentId: "main",
    sessionKey: "session-1",
    ...overrides,
  };
}

function withPrivateLineage(context: AgentRuntimeSessionSpawnContext) {
  return withAgentRuntimeExecutionLineage(context, {
    relation: "sessions_spawn",
    requesterRef: "private-requester-ref",
    controllerRef: "private-controller-ref",
    depth: 2,
    applicableGrantRefs: ["tool:sessions_spawn"],
    localPolicyRefs: ["local-policy"],
    runtimeAssuranceRefs: ["spawn-runtime:subagent"],
    targetPolicyRefs: ["target-policy"],
    externalNativeActions: "observable",
  });
}

function useTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-runtime-"));
  tempHomes.push(home);
  setTestEnvValue("HOME", home);
  setTestEnvValue("OPENCLAW_HOME", home);
  setTestEnvValue("OPENCLAW_STATE_DIR", path.join(home, ".openclaw"));
  closeOpenClawStateDatabaseForTest();
  execApprovalsStoreTesting.reset();
  return home;
}

function readSocketToken(): string | undefined {
  const result = runClientCredentialOperation(process.env, { kind: "socket.read" });
  return result.kind === "socket" ? (result.socket?.socket_token ?? undefined) : undefined;
}

function rewriteSignedPayload(
  token: string,
  changes: Record<string, unknown>,
  resign = true,
): string {
  const [payloadPart, originalSignature] = token.split(".");
  if (!payloadPart) {
    throw new Error("missing payload");
  }
  const payload: Record<string, unknown> = JSON.parse(
    Buffer.from(payloadPart, "base64url").toString("utf8"),
  );
  const rewritten = Buffer.from(JSON.stringify({ ...payload, ...changes })).toString("base64url");
  if (!resign) {
    return `${rewritten}.${originalSignature}`;
  }
  const secret = readSocketToken();
  if (!secret) {
    throw new Error("missing signing secret");
  }
  const signature = createHmac("sha256", secret)
    .update("openclaw:gateway-agent-runtime-identity-token:v1")
    .update("\0")
    .update(rewritten)
    .digest("base64url");
  return `${rewritten}.${signature}`;
}

async function importRuntimeTokenModule() {
  const runtimeToken = await import("./agent-runtime-identity-token.js");
  const stateDb = await import("../state/openclaw-state-db.js");
  reloadedStateDatabaseClosers.add(stateDb.closeOpenClawStateDatabaseForTest);
  return {
    mint: runtimeToken.mintAgentRuntimeIdentityToken,
    verify: runtimeToken.verifyAgentRuntimeIdentityToken,
    direct: runtimeToken.createAgentRuntimeIdentity,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  resetAgentRunRegistryForTest();
  closeOpenClawStateDatabaseForTest();
  for (const closeDatabase of reloadedStateDatabaseClosers) {
    closeDatabase();
  }
  reloadedStateDatabaseClosers.clear();
  execApprovalsStoreTesting.reset();
  envSnapshot.restore();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

let api: Awaited<ReturnType<typeof importRuntimeTokenModule>>;
beforeEach(async () => {
  useTempHome();
  api = await importRuntimeTokenModule();
});
async function createIdentity(params: AgentRuntimeIdentityTokenParams) {
  return api.verify(await api.mint(params));
}

it("retains a worker approval scope through delayed first signed use", async () => {
  const run = operationalRun("worker-scope-signed");
  const lifetime = new AbortController();
  const original = claimAgentRunApprovalAuthority(run.delegatedAuthority, [lifetime.signal]);
  const params = runtimeParams(
    {
      sessionKey: "agent:main:worker-scope",
      approvalAuthority: original,
      workerTurnClaim: {
        sessionId: "worker-scope-session",
        claimId: "worker-scope-claim",
        runId: run.operationalRunInstance.runId,
        placementGeneration: 0,
        owner: { kind: "worker", environmentId: "worker-environment", ownerEpoch: 1 },
      },
    },
    run,
  );
  const token = await api.mint(params);
  lifetime.abort();
  const replacement = claimAgentRunApprovalAuthority(run.delegatedAuthority, [
    new AbortController().signal,
  ]);
  const stale = await api.verify(token);
  expect(stale).toBeDefined();
  expect(validateAgentRunDelegatedAuthority(stale!.delegatedAuthority)).toBe(false);
  expect(validateAgentRunDelegatedAuthority(run.delegatedAuthority)).toBe(true);
  const current = await createIdentity({
    ...params,
    approvalAuthority: replacement,
  });
  expect(current).toBeDefined();
  expect(validateAgentRunDelegatedAuthority(current!.delegatedAuthority)).toBe(true);
  await expect(
    api.direct({
      ...params,
      approvalAuthority: run.delegatedAuthority,
    }),
  ).rejects.toThrow("original claim approval authority");
});

it("rejects signed delegated authority after terminal, replacement, and restart boundaries", async () => {
  const approvalAuthority = await import("./agent-runtime-approval-authority.js");
  const validate = approvalAuthority.createAgentRuntimeApprovalAuthorityValidator();
  const valid = (identity: AgentRuntimeIdentity | undefined) =>
    identity && validate({ ...identity, agentId: "test", sessionKey: "agent:test:test" });
  const first = operationalRun("run-lifecycle");
  const firstRun = first.operationalRunInstance;
  const copied = await createIdentity(runtimeParams({}, first));
  expect(copied).toBeDefined();
  expect(valid(copied)).toBe(true);
  releaseAgentRunDelegatedAuthority(first.delegatedAuthority);
  expect(valid(copied)).toBe(false);
  const replacement = { instanceId: "instance-replacement", runId: firstRun.runId };
  claimAgentRunDelegatedAuthority(replacement);
  expect(valid(copied)).toBe(false);
  const replacementIdentity = await createIdentity({
    ...runtimeParams({}, first),
    operationalRunInstance: replacement,
  });
  expect(valid(replacementIdentity)).toBe(true);
  rotateAgentRunRegistryLifecycleGeneration();
  expect(valid(replacementIdentity)).toBe(false);
});

it("creates direct identities without credentials and rejects inactive runs or expired context", async () => {
  const run = operationalRun();
  const params = runtimeParams({}, run);
  await expect(api.direct(params)).resolves.toMatchObject({
    kind: "agentRuntime",
    ...params,
  });
  expect(readSocketToken()).toBeUndefined();
  await expect(
    api.direct({
      ...params,
      messageActionContext: { expiresAtMs: Date.now() - 1 },
    }),
  ).resolves.toBeUndefined();
  releaseAgentRunDelegatedAuthority(run.delegatedAuthority);
  await expect(api.direct(params)).rejects.toThrow("requires active delegated run authority");
});

it("redeems signed execution lineage once for the active parent", async () => {
  const lineage = await import("./agent-runtime-execution-lineage.js");
  const run = operationalRun();
  const parent = { ...runtimeParams({}, run), delegatedAuthority: run.delegatedAuthority };
  const executionIdentity = createExecutionIdentityAdmissionToken("run-1");
  const sessionSpawnContext = lineage.withAgentRuntimeExecutionLineage(
    { inheritedToolPolicy: { version: 1, allow: ["read"], deny: ["exec"] } },
    {
      relation: "sessions_spawn",
      requesterRef: "requester",
      controllerRef: "controller",
      depth: 1,
      applicableGrantRefs: [],
      localPolicyRefs: [],
      runtimeAssuranceRefs: [],
      targetPolicyRefs: [],
      externalNativeActions: "observable",
    },
  );
  const handoff = lineage.createAgentRuntimeExecutionLineageHandoff({
    ...parent,
    executionIdentity,
    sessionSpawnContext,
  });
  expect(handoff).toBeDefined();
  const params = { ...parent, executionLineageHandoffId: handoff!.id };
  const identity = await createIdentity(params);
  expect(identity).toMatchObject({ executionIdentity, sessionSpawnContext });
  expect(lineage.consumeAgentRuntimeExecutionLineage(identity!)).toBe(true);
  expect(lineage.consumeAgentRuntimeExecutionLineage(identity!)).toBe(false);
  await expect(createIdentity(params)).resolves.toBeUndefined();
});

it.each([false, true])(
  "binds reloaded signing credentials to their state directory (different: %s)",
  async (differentHome) => {
    vi.resetModules();
    const firstProcess = await importRuntimeTokenModule();
    const params = runtimeParams();
    const token = await firstProcess.mint(params);
    const persistedToken = readSocketToken();
    expect(persistedToken).toEqual(expect.any(String));
    expect(persistedToken).not.toHaveLength(0);
    if (differentHome) {
      useTempHome();
    }
    vi.resetModules();
    const secondProcess = await importRuntimeTokenModule();
    if (differentHome) {
      const secondToken = await secondProcess.mint(params);
      expect(secondToken).not.toBe(token);
      await expect(secondProcess.verify(token)).resolves.toBeUndefined();
    } else {
      await expect(secondProcess.verify(token)).resolves.toMatchObject({
        kind: "agentRuntime",
        ...params,
      });
    }
  },
);

it("preserves the signed plugin owner, turn-source route, requesting UI, and cron capture", async () => {
  const params = runtimeParams();
  const identity = await createIdentity({
    ...params,
    approvalOwnerPluginId: " codex ",
    turnSourceChannel: " telegram ",
    turnSourceTo: " chat-1 ",
    turnSourceAccountId: " Work ",
    turnSourceThreadId: " thread-1 ",
    gatewayUiCommandTarget: { connId: " ui-connection-1 ", profileId: " profile-1 " },
    cronToolsAllowCapture: "final-executable-surface",
    cronExecToolTarget: { host: "gateway", ask: "always" },
  });
  expect(identity).toMatchObject({
    kind: "agentRuntime",
    ...params,
    approvalOwnerPluginId: "codex",
    turnSourceChannel: "telegram",
    turnSourceTo: "chat-1",
    turnSourceAccountId: "work",
    turnSourceThreadId: "thread-1",
    gatewayUiCommandTarget: { connId: "ui-connection-1", profileId: "profile-1" },
    cronToolsAllowCapture: "final-executable-surface",
    cronExecToolTarget: { host: "gateway", ask: "always" },
  });
});

it("round-trips explicit local turn provenance without inferring it from the session key", async () => {
  const params = runtimeParams({ sessionKey: "agent:main:main", turnSourceLocal: true });
  await expect(createIdentity(params)).resolves.toMatchObject({
    sessionKey: "agent:main:main",
    turnSourceLocal: true,
  });
  await expect(api.mint({ ...params, turnSourceChannel: "discord" })).rejects.toThrow(
    "cannot be both local and channel-bound",
  );
});

it("preserves the signed payload structural acceptance boundary", async () => {
  const token = await api.mint(runtimeParams({ sessionKey: "agent:main:main" }));
  await expect(
    api.verify(rewriteSignedPayload(token, { futurePayloadField: { version: 2 } })),
  ).resolves.toMatchObject({
    agentId: "main",
    sessionKey: "agent:main:main",
  });
  for (const changes of [
    { turnSourceLocal: false },
    { gatewayUiCommandTarget: { connId: "" } },
    { gatewayUiCommandTarget: { connId: "ui-connection-1", profileId: 1 } },
  ]) {
    await expect(api.verify(rewriteSignedPayload(token, changes))).resolves.toBeUndefined();
  }
});

it.each(["run-1", "run-other"])(
  "round-trips spawn policy with execution identity from %s without private lineage",
  async (identityRunId) => {
    const parentExecutionIdentity = createExecutionIdentityAdmissionToken(identityRunId, {
      contextId: "parent-context",
      executionId: "parent-execution",
    });
    const run = operationalRun();
    const inheritedToolPolicy = {
      version: 1 as const,
      allow: [" read ", "sessions_spawn"],
      deny: ["exec"],
    };
    const spawnFacts: Omit<AgentRuntimeSessionSpawnContext, "inheritedToolPolicy"> = {
      requesterProfileId: "profile-vito",
      requesterSenderIsOwner: false,
      completionOwnerSessionKey: "agent:main:discord:direct:alice",
      resolvedModel: { provider: "custom", model: "custom/model" },
      spawnModelAutoSelection: { model: "custom/custom/model", hasFallbackOrigin: true },
    };
    let token = "";
    const permissionModes =
      identityRunId === "run-1"
        ? ([undefined, "read-only", "guarded", "workspace", "full"] as const)
        : [undefined];
    for (const inheritedPermissionMode of permissionModes) {
      token = await api.mint({
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance: run.operationalRunInstance,
        executionIdentityToken: parentExecutionIdentity,
        sessionSpawnContext: inheritedPermissionMode
          ? { inheritedPermissionMode, inheritedToolPolicy }
          : withPrivateLineage({
              ...spawnFacts,
              requesterProfileId: " profile-vito ",
              completionOwnerSessionKey: " agent:main:discord:direct:alice ",
              inheritedToolPolicy,
            }),
      });
      const [payload] = token.split(".");
      const decodedPayload = Buffer.from(payload ?? "", "base64url").toString("utf8");
      expect(decodedPayload).not.toMatch(/private-(requester|controller)-ref/);
      const identity = await api.verify(token);
      expect(identity).toMatchObject({
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance: run.operationalRunInstance,
        sessionSpawnContext: {
          ...(inheritedPermissionMode ? { inheritedPermissionMode } : spawnFacts),
          inheritedToolPolicy: {
            version: 1,
            allow: ["read", "sessions_spawn"],
            deny: ["exec"],
          },
        },
      });
      if (identityRunId === run.operationalRunInstance.runId) {
        expect(identity?.executionIdentity).toEqual(parentExecutionIdentity);
      } else {
        expect(identity).not.toHaveProperty("executionIdentity");
      }
      expect(readAgentRuntimeExecutionLineage(identity?.sessionSpawnContext)).toBeUndefined();
    }
    if (identityRunId === "run-1") {
      const malformed = rewriteSignedPayload(token, {
        sessionSpawnContext: {
          inheritedToolPolicy,
          inheritedPermissionMode: "approve-all",
        },
      });
      await expect(api.verify(malformed)).resolves.toBeUndefined();
    }
  },
);

it("round-trips a short-lived cron self-management capability", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const params = runtimeParams({
    agentId: "ops",
    sessionKey: "agent:ops:cron:job-1:run:run-1",
  });
  const token = await api.mint({
    ...params,
    cronSelfManagementJobId: " job-1 ",
  });
  await expect(api.verify(token, 60_999)).resolves.toMatchObject({
    kind: "agentRuntime",
    ...params,
    cronSelfManagementContext: { jobId: "job-1", expiresAtMs: 61_000 },
  });
  await expect(api.verify(token, 61_000)).resolves.toBeUndefined();
});

it("round-trips captured-surface grants and rejects unqualified creator grants", async () => {
  const cronCreatorAuthorityGrant = { runId: "run-1", token: "opaque-grant" };
  const params = runtimeParams({ sessionKey: "agent:main:main" });
  const token = await api.mint({
    ...params,
    cronToolsAllowCapture: "final-executable-surface",
    cronCreatorAuthorityGrant,
  });
  await expect(api.verify(token)).resolves.toMatchObject({
    cronToolsAllowCapture: "final-executable-surface",
    cronCreatorAuthorityGrant,
  });
  await expect(api.mint({ ...params, cronCreatorAuthorityGrant })).rejects.toThrow(
    "require tool-surface or authenticated-requester provenance",
  );
  const managementToken = await api.mint({
    ...params,
    cronManagementGrant: cronCreatorAuthorityGrant,
  });
  await expect(api.verify(managementToken)).resolves.toMatchObject({
    cronManagementGrant: cronCreatorAuthorityGrant,
  });
});

it("carries a signed live native requester grant without claiming complete tool capture", async () => {
  const grants = await import("./cron-creator-authority-grant.js");
  const run = operationalRun("run-native-requester");
  const requester = {
    version: 1 as const,
    channel: "discord",
    accountId: "work",
    senderId: "native-current-sender",
  };
  const scope = grants.createCronCreatorAuthorityRunScope(
    run.operationalRunInstance.runId,
    { kind: "external", channel: "discord" },
    undefined,
    undefined,
    requester,
  );
  try {
    const grant = grants.mintCronCreatorAuthorityGrant(
      scope,
      undefined,
      undefined,
      undefined,
      "requester",
    );
    const params = {
      agentId: "main",
      sessionKey: "agent:main:shared-discord",
      operationalRunInstance: run.operationalRunInstance,
      turnSourceChannel: "discord",
      turnSourceAccountId: "work",
      cronCreatorAuthorityGrant: grant,
    };
    const identity = await createIdentity(params);
    expect(identity).toMatchObject({ cronCreatorAuthorityGrant: grant });
    expect(identity).not.toHaveProperty("cronToolsAllowCapture");
    expect(JSON.stringify([identity, scope])).not.toContain(requester.senderId);
    expect(grants.resolveCronCreatorAuthorityGrantProvenance(grant, scope.runId)).toEqual({
      capturesRuntimeAuthority: false,
      channelRequester: requester,
    });
    grants.revokeCronCreatorAuthorityRunScope(scope);
    await expect(createIdentity(params)).rejects.toThrow(
      "require tool-surface or authenticated-requester provenance",
    );
  } finally {
    grants.revokeCronCreatorAuthorityRunScope(scope);
  }
});

it("round-trips scoped cron requester grants without promoting them to local authority", async () => {
  const grants = await import("./cron-creator-authority-grant.js");
  const run = operationalRun("run-scoped-requester");
  const scope = grants.createCronCreatorAuthorityRunScope(
    run.operationalRunInstance.runId,
    { kind: "unknown" },
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  try {
    const grant = grants.mintCronCreatorAuthorityGrant(
      scope,
      undefined,
      undefined,
      undefined,
      "requester",
    );
    const params = runtimeParams({ cronCreatorAuthorityGrant: grant }, run);
    const token = await api.mint(params);
    const identity = await api.verify(token);
    expect(identity).toMatchObject({ cronCreatorAuthorityGrant: grant });
    expect(identity).not.toHaveProperty("cronToolsAllowCapture");
    expect(grants.resolveCronCreatorAuthorityGrantProvenance(grant, scope.runId)).toEqual({
      capturesRuntimeAuthority: false,
      callerScopedCreation: true,
    });
    grants.revokeCronCreatorAuthorityRunScope(scope);
    await expect(api.verify(token)).resolves.toBeUndefined();
    await expect(api.mint(params)).rejects.toThrow("authenticated-requester provenance");
  } finally {
    grants.revokeCronCreatorAuthorityRunScope(scope);
  }
});

it("does not mint local credentials while rejecting invalid presented tokens", async () => {
  await expect(api.verify("not-a-valid-token")).resolves.toBeUndefined();
  expect(readSocketToken()).toBeUndefined();
});

it("rejects a shortened signature or a changed requesting UI", async () => {
  const token = await api.mint(
    runtimeParams({
      gatewayUiCommandTarget: { connId: "ui-connection-1", profileId: "profile-1" },
    }),
  );
  await expect(api.verify(token.slice(0, -1))).resolves.toBeUndefined();
  const gatewayUiCommandTarget = { connId: "another-connection", profileId: "profile-2" };
  const tampered = rewriteSignedPayload(token, { gatewayUiCommandTarget }, false);
  await expect(api.verify(tampered)).resolves.toBeUndefined();
});

it.each([
  { expiresAtMs: 5000, verifyAtMs: 4000, expectedExpiry: 5000 },
  { expiresAtMs: Number.MAX_SAFE_INTEGER, verifyAtMs: 60_999, expectedExpiry: 61_000 },
])(
  "bounds and expires a message action bearer with lifetime $expiresAtMs",
  async ({ expiresAtMs, verifyAtMs, expectedExpiry }) => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const messageActionContext =
      expiresAtMs === 5000
        ? {
            expiresAtMs,
            sourceReplyFinal: true as const,
            sourceReplyToolCallId: "message-call-1",
            sourceReplySessionKey: "agent:main:main",
            sessionId: "session-id-1",
            requesterAccountId: "ops",
            requesterSenderId: "sender-1",
            requesterSenderName: "Sender One",
            requesterSenderUsername: "sender-one",
            requesterSenderE164: "+15551234567",
            toolContext: {
              currentChannelProvider: "matrix",
              currentChannelId: "!room:example.org",
              currentChatType: "direct" as const,
              currentSourceTurnId: "channel-user:v1:source-1",
            },
          }
        : { expiresAtMs };
    const params = runtimeParams({ messageActionContext });
    const token = await api.mint(params);
    await expect(api.verify(token, verifyAtMs)).resolves.toMatchObject({
      kind: "agentRuntime",
      ...params,
      messageActionContext: { ...messageActionContext, expiresAtMs: expectedExpiry },
    });
    await expect(api.verify(token, expectedExpiry)).resolves.toBeUndefined();
  },
);

it.each([false, true])(
  "queues token verification behind approvals updates and rechecks expiry (expires: %s)",
  async (expires) => {
    const { updateExecApprovals } = await import("../infra/exec-approvals.js");
    const params = runtimeParams();
    const token = await api.mint({
      ...params,
      ...(expires ? { messageActionContext: { expiresAtMs: 5000 } } : {}),
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(4000);
    const count = expires ? 1 : 8;
    const write = updateExecApprovals({
      update: { kind: "replace", file: readExecApprovalsSnapshot().file },
    });
    // Each queued read retains its expiry check while the approvals writer settles.
    const verifications = Array.from({ length: count }, () => api.verify(token));
    if (expires) {
      nowSpy.mockReturnValue(5000);
    }
    await write;
    const expected = expires
      ? undefined
      : expect.objectContaining({
          kind: "agentRuntime",
          ...params,
          delegatedAuthority: expect.objectContaining({ kind: "local" }),
        });
    expect(await Promise.all(verifications)).toEqual(Array.from({ length: count }, () => expected));
  },
);
