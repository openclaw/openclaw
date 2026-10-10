import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import {
  claimAgentRunDelegatedAuthority,
  claimAgentRunApprovalAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { readExecApprovalsSnapshot } from "../infra/exec-approvals-store.js";
import { testing as execApprovalsStoreTesting } from "../infra/exec-approvals-store.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  readAgentRuntimeExecutionLineage,
  withAgentRuntimeExecutionLineage,
} from "./agent-runtime-execution-lineage.js";
import type { AgentRuntimeIdentityTokenParams } from "./agent-runtime-identity-token.js";

const envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);

const tempHomes: string[] = [];
const reloadedStateDatabaseClosers = new Set<() => void>();

function operationalRun(runId = "run-1") {
  const operationalRunInstance = { instanceId: `instance-${runId}`, runId } as const;
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  return { operationalRunInstance, delegatedAuthority };
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

function readExecApprovals(): {
  socket?: { token?: string };
} {
  return readExecApprovalsSnapshot().file;
}

function rewriteSignedPayload(
  token: string,
  mutate: (payload: Record<string, unknown>) => void,
): string {
  const [payloadPart] = token.split(".");
  if (!payloadPart) {
    throw new Error("missing payload");
  }
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<
    string,
    unknown
  >;
  mutate(payload);
  const rewritten = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const secret = readExecApprovals().socket?.token;
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

async function importRuntimeTokenModule(): Promise<
  typeof import("./agent-runtime-identity-token.js")
> {
  const runtimeToken = await import("./agent-runtime-identity-token.js");
  const stateDb = await import("../state/openclaw-state-db.js");
  reloadedStateDatabaseClosers.add(stateDb.closeOpenClawStateDatabaseForTest);
  return runtimeToken;
}

function validateDelegatedAuthority(
  approvalAuthority: typeof import("./agent-runtime-approval-authority.js"),
  authority: import("./agent-runtime-identity-token.js").AgentRuntimeDelegatedAuthority,
): boolean {
  return approvalAuthority.createAgentRuntimeApprovalAuthorityValidator()({
    kind: "agentRuntime",
    agentId: "test",
    sessionKey: "agent:test:test",
    operationalRunInstance: authority.operationalRunInstance,
    delegatedAuthority: authority,
  });
}

async function createIdentity(
  runtimeToken: typeof import("./agent-runtime-identity-token.js"),
  mode: "signed" | "direct",
  params: AgentRuntimeIdentityTokenParams,
) {
  return mode === "direct"
    ? runtimeToken.createAgentRuntimeIdentity(params)
    : runtimeToken.verifyAgentRuntimeIdentityToken(
        await runtimeToken.mintAgentRuntimeIdentityToken(params),
      );
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

describe("agent runtime identity token", () => {
  beforeEach(() => {
    useTempHome();
  });

  it.each(["signed", "direct"] as const)(
    "retains a worker approval scope through delayed first %s use",
    async (mode) => {
      const runtimeToken = await importRuntimeTokenModule();
      const run = operationalRun(`worker-scope-${mode}`);
      const lifetime = new AbortController();
      const original = claimAgentRunApprovalAuthority(run.delegatedAuthority, [lifetime.signal]);
      const params: AgentRuntimeIdentityTokenParams = {
        agentId: "main",
        sessionKey: "agent:main:worker-scope",
        operationalRunInstance: run.operationalRunInstance,
        approvalAuthority: original,
        workerTurnClaim: {
          sessionId: "worker-scope-session",
          claimId: "worker-scope-claim",
          runId: run.operationalRunInstance.runId,
          placementGeneration: 0,
          owner: { kind: "worker", environmentId: "worker-environment", ownerEpoch: 1 },
        },
      };
      const token =
        mode === "signed" ? await runtimeToken.mintAgentRuntimeIdentityToken(params) : undefined;
      const direct =
        mode === "direct" ? await runtimeToken.createAgentRuntimeIdentity(params) : undefined;
      lifetime.abort();
      const replacement = claimAgentRunApprovalAuthority(run.delegatedAuthority, [
        new AbortController().signal,
      ]);
      const stale = token ? await runtimeToken.verifyAgentRuntimeIdentityToken(token) : direct;
      if (!stale) {
        throw new Error("Expected decoded worker identity");
      }
      expect(validateAgentRunDelegatedAuthority(stale.delegatedAuthority)).toBe(false);
      expect(validateAgentRunDelegatedAuthority(run.delegatedAuthority)).toBe(true);
      const current = await createIdentity(runtimeToken, mode, {
        ...params,
        approvalAuthority: replacement,
      });
      if (!current) {
        throw new Error("Expected replacement worker identity");
      }
      expect(validateAgentRunDelegatedAuthority(current.delegatedAuthority)).toBe(true);
      await expect(
        runtimeToken.createAgentRuntimeIdentity({
          ...params,
          approvalAuthority: run.delegatedAuthority,
        }),
      ).rejects.toThrow("original claim approval authority");
    },
  );

  it.each(["signed", "direct"] as const)(
    "rejects %s delegated authority after terminal, replacement, and restart boundaries",
    async (mode) => {
      const runtimeToken = await importRuntimeTokenModule();
      const approvalAuthority = await import("./agent-runtime-approval-authority.js");
      const first = operationalRun("run-lifecycle");
      const firstRun = first.operationalRunInstance;
      const copied = await createIdentity(runtimeToken, mode, {
        agentId: "main",
        sessionKey: "session-1",
        operationalRunInstance: firstRun,
      });
      expect(copied).toBeDefined();
      expect(
        copied && validateDelegatedAuthority(approvalAuthority, copied.delegatedAuthority),
      ).toBe(true);

      releaseAgentRunDelegatedAuthority(first.delegatedAuthority);
      expect(
        copied && validateDelegatedAuthority(approvalAuthority, copied.delegatedAuthority),
      ).toBe(false);

      const replacement = { instanceId: "instance-replacement", runId: firstRun.runId };
      claimAgentRunDelegatedAuthority(replacement);
      expect(
        copied && validateDelegatedAuthority(approvalAuthority, copied.delegatedAuthority),
      ).toBe(false);

      const replacementIdentity = await createIdentity(runtimeToken, mode, {
        agentId: "main",
        sessionKey: "session-1",
        operationalRunInstance: replacement,
      });
      expect(
        replacementIdentity &&
          validateDelegatedAuthority(approvalAuthority, replacementIdentity.delegatedAuthority),
      ).toBe(true);

      rotateAgentRunRegistryLifecycleGeneration();
      expect(
        replacementIdentity &&
          validateDelegatedAuthority(approvalAuthority, replacementIdentity.delegatedAuthority),
      ).toBe(false);
    },
  );

  it("creates direct identities without credentials and rejects inactive runs or expired context", async () => {
    const runtimeToken = await importRuntimeTokenModule();
    const run = operationalRun();
    const params = {
      agentId: "main",
      sessionKey: "session-1",
      operationalRunInstance: run.operationalRunInstance,
    };
    await expect(runtimeToken.createAgentRuntimeIdentity(params)).resolves.toMatchObject({
      kind: "agentRuntime",
      ...params,
    });
    expect(readExecApprovalsSnapshot().exists).toBe(false);

    await expect(
      runtimeToken.createAgentRuntimeIdentity({
        ...params,
        messageActionContext: { expiresAtMs: Date.now() - 1 },
      }),
    ).resolves.toBeUndefined();

    releaseAgentRunDelegatedAuthority(run.delegatedAuthority);
    await expect(runtimeToken.createAgentRuntimeIdentity(params)).rejects.toThrow(
      "requires active delegated run authority",
    );
  });

  it.each(["signed", "direct"] as const)(
    "redeems %s execution lineage once for the active parent",
    async (mode) => {
      const runtimeToken = await importRuntimeTokenModule();
      const lineage = await import("./agent-runtime-execution-lineage.js");
      const run = operationalRun();
      const parent = {
        agentId: "main",
        sessionKey: "session-1",
        ...run,
      };
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
      const identity = await createIdentity(runtimeToken, mode, params);
      expect(identity).toMatchObject({ executionIdentity, sessionSpawnContext });
      expect(lineage.consumeAgentRuntimeExecutionLineage(identity!)).toBe(true);
      expect(lineage.consumeAgentRuntimeExecutionLineage(identity!)).toBe(false);
      await expect(createIdentity(runtimeToken, mode, params)).resolves.toBeUndefined();
    },
  );

  it.each([false, true])(
    "binds reloaded signing credentials to their state directory (different: %s)",
    async (differentHome) => {
      vi.resetModules();
      const firstProcess = await importRuntimeTokenModule();
      const params = {
        agentId: "main",
        sessionKey: "session-1",
        ...operationalRun(),
      };
      const token = await firstProcess.mintAgentRuntimeIdentityToken(params);

      const persistedToken = readExecApprovals().socket?.token;
      expect(persistedToken).toEqual(expect.any(String));
      expect(persistedToken).not.toHaveLength(0);

      if (differentHome) {
        useTempHome();
      }
      vi.resetModules();
      const secondProcess = await importRuntimeTokenModule();
      if (differentHome) {
        const secondToken = await secondProcess.mintAgentRuntimeIdentityToken(params);
        expect(secondToken).not.toBe(token);
        await expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).resolves.toBeUndefined();
      } else {
        await expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
          kind: "agentRuntime",
          ...params,
        });
      }
    },
  );

  it.each(["signed", "direct"] as const)(
    "preserves the %s plugin owner, turn-source route, requesting UI, and cron capture",
    async (mode) => {
      const runtimeToken = await importRuntimeTokenModule();
      const identity = await createIdentity(runtimeToken, mode, {
        agentId: "main",
        sessionKey: "session-1",
        ...operationalRun(),
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
        agentId: "main",
        sessionKey: "session-1",
        operationalRunInstance: operationalRun().operationalRunInstance,
        approvalOwnerPluginId: "codex",
        turnSourceChannel: "telegram",
        turnSourceTo: "chat-1",
        turnSourceAccountId: "work",
        turnSourceThreadId: "thread-1",
        gatewayUiCommandTarget: { connId: "ui-connection-1", profileId: "profile-1" },
        cronToolsAllowCapture: "final-executable-surface",
        cronExecToolTarget: { host: "gateway", ask: "always" },
      });
    },
  );

  it("round-trips explicit local turn provenance without inferring it from the session key", async () => {
    const runtimeToken = await importRuntimeTokenModule();
    const run = operationalRun();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "agent:main:main",
      operationalRunInstance: run.operationalRunInstance,
      turnSourceLocal: true,
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      turnSourceLocal: true,
    });
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance: run.operationalRunInstance,
        turnSourceChannel: "discord",
        turnSourceLocal: true,
      }),
    ).rejects.toThrow("cannot be both local and channel-bound");
  });

  it("preserves the signed payload structural acceptance boundary", async () => {
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "agent:main:main",
      ...operationalRun(),
    });

    const withUnknownField = rewriteSignedPayload(token, (payload) => {
      payload.futurePayloadField = { version: 2 };
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(withUnknownField),
    ).resolves.toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:main",
    });

    const withInvalidKnownField = rewriteSignedPayload(token, (payload) => {
      payload.turnSourceLocal = false;
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(withInvalidKnownField),
    ).resolves.toBeUndefined();

    for (const gatewayUiCommandTarget of [
      { connId: "" },
      { connId: "ui-connection-1", profileId: 1 },
    ]) {
      const withInvalidUiTarget = rewriteSignedPayload(token, (payload) => {
        payload.gatewayUiCommandTarget = gatewayUiCommandTarget;
      });
      await expect(
        runtimeToken.verifyAgentRuntimeIdentityToken(withInvalidUiTarget),
      ).resolves.toBeUndefined();
    }
  });

  it.each(["run-1", "run-other"])(
    "round-trips spawn policy with execution identity from %s without private lineage",
    async (identityRunId) => {
      const runtimeToken = await importRuntimeTokenModule();
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
      let token = "";
      const permissionModes =
        identityRunId === "run-1"
          ? ([undefined, "read-only", "guarded", "workspace", "full"] as const)
          : [undefined];
      for (const inheritedPermissionMode of permissionModes) {
        token = await runtimeToken.mintAgentRuntimeIdentityToken({
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance: run.operationalRunInstance,
          executionIdentityToken: parentExecutionIdentity,
          sessionSpawnContext: inheritedPermissionMode
            ? { inheritedPermissionMode, inheritedToolPolicy }
            : withAgentRuntimeExecutionLineage(
                {
                  requesterProfileId: " profile-vito ",
                  requesterSenderIsOwner: false,
                  completionOwnerSessionKey: " agent:main:discord:direct:alice ",
                  resolvedModel: { provider: "custom", model: "custom/model" },
                  spawnModelAutoSelection: {
                    model: "custom/custom/model",
                    hasFallbackOrigin: true,
                  },
                  inheritedToolPolicy,
                },
                {
                  relation: "sessions_spawn",
                  requesterRef: "private-requester-ref",
                  controllerRef: "private-controller-ref",
                  depth: 2,
                  applicableGrantRefs: ["tool:sessions_spawn"],
                  localPolicyRefs: ["local-policy"],
                  runtimeAssuranceRefs: ["spawn-runtime:subagent"],
                  targetPolicyRefs: ["target-policy"],
                  externalNativeActions: "observable",
                },
              ),
        });

        const [payload] = token.split(".");
        const decodedPayload = Buffer.from(payload ?? "", "base64url").toString("utf8");
        expect(decodedPayload).not.toContain("private-requester-ref");
        expect(decodedPayload).not.toContain("private-controller-ref");

        const identity = await runtimeToken.verifyAgentRuntimeIdentityToken(token);
        expect(identity).toMatchObject({
          kind: "agentRuntime",
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance: run.operationalRunInstance,
          sessionSpawnContext: {
            ...(inheritedPermissionMode
              ? { inheritedPermissionMode }
              : {
                  requesterProfileId: "profile-vito",
                  requesterSenderIsOwner: false,
                  completionOwnerSessionKey: "agent:main:discord:direct:alice",
                  resolvedModel: { provider: "custom", model: "custom/model" },
                  spawnModelAutoSelection: {
                    model: "custom/custom/model",
                    hasFallbackOrigin: true,
                  },
                }),
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
        const malformed = rewriteSignedPayload(token, (payload) => {
          payload.sessionSpawnContext = {
            inheritedToolPolicy,
            inheritedPermissionMode: "approve-all",
          };
        });
        await expect(
          runtimeToken.verifyAgentRuntimeIdentityToken(malformed),
        ).resolves.toBeUndefined();
      }
    },
  );

  it("round-trips a short-lived cron self-management capability", async () => {
    const runtimeToken = await importRuntimeTokenModule();
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "ops",
      sessionKey: "agent:ops:cron:job-1:run:run-1",
      ...operationalRun(),
      cronSelfManagementJobId: " job-1 ",
    });

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 60_999),
    ).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "ops",
      sessionKey: "agent:ops:cron:job-1:run:run-1",
      operationalRunInstance: operationalRun().operationalRunInstance,
      cronSelfManagementContext: { jobId: "job-1", expiresAtMs: 61_000 },
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 61_000),
    ).resolves.toBeUndefined();
  });

  it("round-trips captured-surface grants and rejects unqualified creator grants", async () => {
    const runtimeToken = await importRuntimeTokenModule();
    const run = operationalRun();
    const cronCreatorAuthorityGrant = { runId: "run-1", token: "opaque-grant" };
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "agent:main:main",
      operationalRunInstance: run.operationalRunInstance,
      cronToolsAllowCapture: "final-executable-surface",
      cronCreatorAuthorityGrant,
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      cronToolsAllowCapture: "final-executable-surface",
      cronCreatorAuthorityGrant,
    });
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance: run.operationalRunInstance,
        cronCreatorAuthorityGrant,
      }),
    ).rejects.toThrow("require tool-surface or authenticated-requester provenance");
    const managementToken = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "agent:main:main",
      operationalRunInstance: run.operationalRunInstance,
      cronManagementGrant: cronCreatorAuthorityGrant,
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(managementToken),
    ).resolves.toMatchObject({
      cronManagementGrant: cronCreatorAuthorityGrant,
    });
  });

  it.each(["signed", "direct"] as const)(
    "carries a %s live native requester grant without claiming complete tool capture",
    async (mode) => {
      const runtimeToken = await importRuntimeTokenModule();
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
        const identity = await createIdentity(runtimeToken, mode, params);
        expect(identity).toMatchObject({ cronCreatorAuthorityGrant: grant });
        expect(identity).not.toHaveProperty("cronToolsAllowCapture");
        expect(JSON.stringify(identity)).not.toContain(requester.senderId);
        expect(JSON.stringify(scope)).not.toContain(requester.senderId);
        expect(grants.resolveCronCreatorAuthorityGrantProvenance(grant, scope.runId)).toEqual({
          capturesRuntimeAuthority: false,
          channelRequester: requester,
        });
        grants.revokeCronCreatorAuthorityRunScope(scope);
        await expect(createIdentity(runtimeToken, mode, params)).rejects.toThrow(
          "require tool-surface or authenticated-requester provenance",
        );
      } finally {
        grants.revokeCronCreatorAuthorityRunScope(scope);
      }
    },
  );

  it("does not mint local credentials while rejecting invalid presented tokens", async () => {
    const runtimeToken = await importRuntimeTokenModule();

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken("not-a-valid-token"),
    ).resolves.toBeUndefined();
    expect(readExecApprovalsSnapshot().exists).toBe(false);
  });

  it("rejects a shortened signature or a changed requesting UI", async () => {
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
      gatewayUiCommandTarget: { connId: "ui-connection-1", profileId: "profile-1" },
    });

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token.slice(0, -1)),
    ).resolves.toBeUndefined();
    const [payloadPart, signature] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadPart!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    payload.gatewayUiCommandTarget = { connId: "another-connection", profileId: "profile-2" };
    const changedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(`${changedPayload}.${signature}`),
    ).resolves.toBeUndefined();
  });

  it.each([
    { expiresAtMs: 5000, verifyAtMs: 4000, expectedExpiry: 5000 },
    { expiresAtMs: Number.MAX_SAFE_INTEGER, verifyAtMs: 60_999, expectedExpiry: 61_000 },
  ])(
    "bounds and expires a message action bearer with lifetime $expiresAtMs",
    async ({ expiresAtMs, verifyAtMs, expectedExpiry }) => {
      const runtimeToken = await importRuntimeTokenModule();
      vi.spyOn(Date, "now").mockReturnValue(1000);
      const messageActionContext: NonNullable<
        AgentRuntimeIdentityTokenParams["messageActionContext"]
      > =
        expiresAtMs === 5000
          ? {
              expiresAtMs,
              sourceReplyFinal: true,
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
                currentChatType: "direct",
                currentSourceTurnId: "channel-user:v1:source-1",
              },
            }
          : { expiresAtMs };
      const params = {
        agentId: "main",
        sessionKey: "session-1",
        ...operationalRun(),
        messageActionContext,
      };
      const token = await runtimeToken.mintAgentRuntimeIdentityToken(params);

      await expect(
        runtimeToken.verifyAgentRuntimeIdentityToken(token, verifyAtMs),
      ).resolves.toMatchObject({
        kind: "agentRuntime",
        ...params,
        messageActionContext: { ...messageActionContext, expiresAtMs: expectedExpiry },
      });
      await expect(
        runtimeToken.verifyAgentRuntimeIdentityToken(token, expectedExpiry),
      ).resolves.toBeUndefined();
    },
  );

  it.each([false, true])(
    "queues token verification behind approvals updates and rechecks expiry (expires: %s)",
    async (expires) => {
      const runtimeToken = await importRuntimeTokenModule();
      const { updateExecApprovals } = await import("../infra/exec-approvals.js");
      const token = await runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "main",
        sessionKey: "session-1",
        ...operationalRun(),
        ...(expires ? { messageActionContext: { expiresAtMs: 5000 } } : {}),
      });
      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(4000);
      const count = expires ? 1 : 8;
      const write = updateExecApprovals({
        update: { kind: "replace", file: readExecApprovalsSnapshot().file },
      });
      // Parallel identity reads retain their own expiry check while the shared
      // writer settles an earlier approvals command.
      const verifications = Array.from({ length: count }, () =>
        runtimeToken.verifyAgentRuntimeIdentityToken(token),
      );
      if (expires) {
        nowSpy.mockReturnValue(5000);
      }

      await write;
      const verified = await Promise.all(verifications);
      expect(verified).toHaveLength(count);
      for (const identity of verified) {
        if (expires) {
          expect(identity).toBeUndefined();
        } else {
          expect(identity).toMatchObject({
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "session-1",
            operationalRunInstance: operationalRun().operationalRunInstance,
            delegatedAuthority: { kind: "local" },
          });
        }
      }
    },
  );
});
