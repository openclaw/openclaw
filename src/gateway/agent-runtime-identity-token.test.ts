import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
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
  runtimeToken: typeof import("./agent-runtime-identity-token.js"),
  authority: import("./agent-runtime-identity-token.js").AgentRuntimeDelegatedAuthority,
): boolean {
  return runtimeToken.createAgentRuntimeApprovalAuthorityValidator()({
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
  it.each(["signed", "direct"] as const)(
    "rejects %s delegated authority after terminal, replacement, and restart boundaries",
    async (mode) => {
      useTempHome();
      const runtimeToken = await importRuntimeTokenModule();
      const first = operationalRun("run-lifecycle");
      const firstRun = first.operationalRunInstance;
      const copied = await createIdentity(runtimeToken, mode, {
        agentId: "main",
        sessionKey: "session-1",
        operationalRunInstance: firstRun,
      });
      expect(copied).toBeDefined();
      expect(copied && validateDelegatedAuthority(runtimeToken, copied.delegatedAuthority)).toBe(
        true,
      );

      releaseAgentRunDelegatedAuthority(first.delegatedAuthority);
      expect(copied && validateDelegatedAuthority(runtimeToken, copied.delegatedAuthority)).toBe(
        false,
      );

      const replacement = { instanceId: "instance-replacement", runId: firstRun.runId };
      claimAgentRunDelegatedAuthority(replacement);
      expect(copied && validateDelegatedAuthority(runtimeToken, copied.delegatedAuthority)).toBe(
        false,
      );

      const replacementIdentity = await createIdentity(runtimeToken, mode, {
        agentId: "main",
        sessionKey: "session-1",
        operationalRunInstance: replacement,
      });
      expect(
        replacementIdentity &&
          validateDelegatedAuthority(runtimeToken, replacementIdentity.delegatedAuthority),
      ).toBe(true);

      rotateAgentRunRegistryLifecycleGeneration();
      expect(
        replacementIdentity &&
          validateDelegatedAuthority(runtimeToken, replacementIdentity.delegatedAuthority),
      ).toBe(false);
    },
  );

  it("creates direct identities without credentials and rejects inactive runs or expired context", async () => {
    useTempHome();
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
      useTempHome();
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

  it("persists the local signing secret so tokens verify across processes", async () => {
    useTempHome();
    vi.resetModules();
    const firstProcess = await importRuntimeTokenModule();

    const token = await firstProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
    });

    const persistedToken = readExecApprovals().socket?.token;
    expect(persistedToken).toEqual(expect.any(String));
    expect(persistedToken).not.toHaveLength(0);

    vi.resetModules();
    const secondProcess = await importRuntimeTokenModule();
    await expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
      operationalRunInstance: operationalRun().operationalRunInstance,
    });
  });

  it.each(["signed", "direct"] as const)(
    "preserves the %s plugin owner, turn-source route, and requesting UI",
    async (mode) => {
      useTempHome();
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
      });
    },
  );

  it("round-trips explicit local turn provenance without inferring it from the session key", async () => {
    useTempHome();
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
    useTempHome();
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

  it("omits execution identity from a different operational run", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun("run-1"),
      executionIdentityToken: createExecutionIdentityAdmissionToken("run-other"),
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
      operationalRunInstance: operationalRun("run-1").operationalRunInstance,
    });
  });

  it("round-trips spawn policy without serializing private lineage", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const parentExecutionIdentity = createExecutionIdentityAdmissionToken("run-1", {
      contextId: "parent-context",
      executionId: "parent-execution",
    });
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "agent:main:main",
      ...operationalRun(),
      executionIdentityToken: parentExecutionIdentity,
      sessionSpawnContext: withAgentRuntimeExecutionLineage(
        {
          requesterProfileId: " profile-vito ",
          completionOwnerSessionKey: " agent:main:discord:direct:alice ",
          resolvedModel: { provider: "custom", model: "custom/model" },
          spawnModelAutoSelection: { model: "custom/custom/model", hasFallbackOrigin: true },
          inheritedToolPolicy: {
            version: 1,
            allow: [" read ", "sessions_spawn"],
            deny: ["exec"],
          },
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
      executionIdentity: parentExecutionIdentity,
      sessionSpawnContext: {
        requesterProfileId: "profile-vito",
        completionOwnerSessionKey: "agent:main:discord:direct:alice",
        resolvedModel: { provider: "custom", model: "custom/model" },
        spawnModelAutoSelection: { model: "custom/custom/model", hasFallbackOrigin: true },
        inheritedToolPolicy: {
          version: 1,
          allow: ["read", "sessions_spawn"],
          deny: ["exec"],
        },
      },
    });
    expect(readAgentRuntimeExecutionLineage(identity?.sessionSpawnContext)).toBeUndefined();
  });

  it("round-trips a short-lived cron self-management capability", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
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
    nowSpy.mockRestore();
  });

  it.each(["signed", "direct"] as const)(
    "preserves %s final cron-cap capture provenance",
    async (mode) => {
      useTempHome();
      const runtimeToken = await importRuntimeTokenModule();
      const run = operationalRun();
      const identity = await createIdentity(runtimeToken, mode, {
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance: run.operationalRunInstance,
        cronToolsAllowCapture: "final-executable-surface",
        cronExecToolTarget: { host: "gateway", ask: "always" },
      });

      expect(identity).toMatchObject({
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:main",
        operationalRunInstance: run.operationalRunInstance,
        cronToolsAllowCapture: "final-executable-surface",
        cronExecToolTarget: { host: "gateway", ask: "always" },
      });
    },
  );

  it("round-trips captured-surface grants and rejects unqualified creator grants", async () => {
    useTempHome();
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
      useTempHome();
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
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken("not-a-valid-token"),
    ).resolves.toBeUndefined();
    expect(readExecApprovalsSnapshot().exists).toBe(false);
  });

  it("rejects a shortened signature or a changed requesting UI", async () => {
    useTempHome();
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

  it("rejects tokens minted from a different local state directory", async () => {
    useTempHome();
    vi.resetModules();
    const firstProcess = await importRuntimeTokenModule();
    const token = await firstProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
    });
    expect(readExecApprovals().socket?.token).toEqual(expect.any(String));

    useTempHome();
    vi.resetModules();
    const secondProcess = await importRuntimeTokenModule();
    const secondToken = await secondProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
    });

    expect(secondToken).not.toBe(token);
    await expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).resolves.toBeUndefined();
  });

  it("round-trips signed message action context and rejects it after expiry", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
      messageActionContext: {
        expiresAtMs: 5000,
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
      },
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token, 4000)).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
      messageActionContext: {
        expiresAtMs: 5000,
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
      },
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 5000),
    ).resolves.toBeUndefined();
  });

  it("bounds run-lifetime message action bearers independently of local revocation", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
      messageActionContext: { expiresAtMs: Number.MAX_SAFE_INTEGER },
    });

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 60_999),
    ).resolves.toMatchObject({
      messageActionContext: { expiresAtMs: 61_000 },
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 61_000),
    ).resolves.toBeUndefined();
    nowSpy.mockRestore();
  });

  it("queues parallel verifications behind a same-process approvals update", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { updateExecApprovals } = await import("../infra/exec-approvals.js");
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
    });
    let verifications: Array<ReturnType<typeof runtimeToken.verifyAgentRuntimeIdentityToken>> = [];

    await updateExecApprovals({
      update: () => {
        // Verification can begin while another parallel agent call still owns
        // the process-local approvals lock. It must queue behind that owner.
        verifications = Array.from({ length: 8 }, () =>
          runtimeToken.verifyAgentRuntimeIdentityToken(token),
        );
        return null;
      },
    });

    const verified = await Promise.all(verifications);
    expect(verified).toHaveLength(8);
    for (const identity of verified) {
      expect(identity).toMatchObject({
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "session-1",
        operationalRunInstance: operationalRun().operationalRunInstance,
        delegatedAuthority: { kind: "local" },
      });
    }
  });

  it("rechecks message action expiry after waiting for an approvals update", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { updateExecApprovals } = await import("../infra/exec-approvals.js");
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      ...operationalRun(),
      messageActionContext: { expiresAtMs: 5000 },
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(4000);
    let verification!: ReturnType<typeof runtimeToken.verifyAgentRuntimeIdentityToken>;

    await updateExecApprovals({
      update: () => {
        verification = runtimeToken.verifyAgentRuntimeIdentityToken(token);
        nowSpy.mockReturnValue(5000);
        return null;
      },
    });

    await expect(verification).resolves.toBeUndefined();
  });
});
