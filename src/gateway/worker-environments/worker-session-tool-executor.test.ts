// Register the shared tool mocks before any runtime dependency is evaluated.
import "./worker-session-tool-executor.test-support.js";
import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../../packages/gateway-protocol/src/index.js";
import { SkillLibraryWorkshopSchema } from "../../../packages/gateway-protocol/src/schema/worker-skill-workshop.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { createOpenClawCodingToolsInternal } from "../../agents/agent-tools.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { prepareCoreToolPolicy } from "../../agents/prepared-tool-surface.js";
import type { AnyAgentTool } from "../../agents/tools/common.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { ExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../../audit/runtime-action-decision.js";
import { claimAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { readAgentRuntimeExecutionLineage } from "../agent-runtime-execution-lineage.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { bindWorkerTurnOwner } from "./placement-turn-claim-events.js";
import * as environmentServiceModule from "./service.js";
import { registerWorkerDelegationPolicyTests } from "./worker-session-tool-executor.delegation.suite.js";
import { registerWorkerGatewayToolExecutionTests } from "./worker-session-tool-executor.gateway-tools.suite.js";
const {
  workerSessionToolTestMocks,
  SOURCE,
  CHILD,
  GRANDCHILD,
  CLOUD_PROFILE,
  PARENT_EXECUTION_IDENTITY_TOKEN,
  resolveGatewayContext,
  installWorkerSessionToolTestFixture,
} = await import("./worker-session-tool-executor.test-support.js");

const fixtureMocks = workerSessionToolTestMocks();
const {
  sessionEntries,
  delivered,
  gatewayRequest,
  gatewayCreate,
  gatewayRuntimeIdentity,
  dispatchChild,
  spawnCallerIdentity,
  spawnArgs,
} = fixtureMocks;

function publicationCase(
  name: string,
  expected: boolean,
  overrides: Partial<{ allow: string[]; deny: string[]; promptAllow: string[] }> = {},
) {
  return {
    name,
    expected,
    allow: ["sessions_spawn", "github_publish"],
    deny: [],
    promptAllow: undefined,
    ...overrides,
  };
}

function presenceSource(
  source: string,
  deniedReason?: string,
  options: NonNullable<Parameters<typeof installWorkerSessionToolTestFixture>[1]> = {},
) {
  return { source, deniedReason, ...options };
}

describe("worker session tool topology", () => {
  const getFixture = installWorkerSessionToolTestFixture(fixtureMocks, {
    operatorProfileId: "profile-worker-requester",
  });
  let f: ReturnType<typeof getFixture>;

  beforeEach(() => {
    resetGlobalHookRunner();
    f = getFixture();
    f.setEntry(SOURCE.sessionKey, SOURCE.sessionId);
  });

  afterEach(resetGlobalHookRunner);

  async function workshop(execute: AnyAgentTool["execute"]) {
    return (
      await f.createTools({
        name: "skill_workshop",
        label: "Workshop",
        description: "Library",
        parameters: SkillLibraryWorkshopSchema,
        execute,
      })
    ).find((tool) => tool.name === "skill_workshop")!;
  }

  function loseCreationResponse(parent: { sessionKey: string; sessionId: string } = SOURCE) {
    gatewayCreate.mockImplementationOnce(async (request: { params: Record<string, unknown> }) => {
      f.spawnState.order.push("create");
      f.spawnState.childSessionKey = String(request.params.key);
      f.setEntry(f.spawnState.childSessionKey, CHILD.sessionId, parent);
      throw new Error("session creation response was lost");
    });
  }

  it.each([
    publicationCase("permitted", true),
    publicationCase("unrestricted", true, { allow: undefined }),
    publicationCase("explicitly denied", false, { deny: ["github_publish"] }),
    publicationCase("prompt restricted", false, { promptAllow: ["sessions_spawn"] }),
  ])(
    "captures $name publication for a new worker child",
    async ({ allow, deny, promptAllow, expected }) => {
      const { identity, spawn, placements, sourceClaim } = f;
      const config = { tools: { allow, deny } };
      const inheritedPublicationToolRef: { current?: AnyAgentTool } = {};
      const runtime = getFixture().createToolRuntime({
        inheritedPublicationToolRef,
        prepareTools: (adapters) =>
          createOpenClawCodingToolsInternal(
            {
              config,
              sessionKey: SOURCE.sessionKey,
              githubPublicationAvailable: false,
              inheritedPublicationToolRef,
              wrapBeforeToolCallHook: false,
              toolConstructionPlan: {
                includeBaseCodingTools: false,
                includeShellTools: false,
                includeChannelTools: false,
                includeOpenClawTools: true,
                includePluginTools: false,
              },
              conversationCapabilityProfile: resolveConversationCapabilityProfile({
                config,
                sessionKey: SOURCE.sessionKey,
                preparedSessionCapabilityStore: {},
              }),
            },
            undefined,
            undefined,
            { tools: adapters, policy: prepareCoreToolPolicy({}) },
          ),
      });
      const surface = await runtime.getSurface(identity);
      expect(surface.tools.map((tool) => tool.definition.name)).not.toContain("github_publish");
      runtime.applyPromptToolsAllow(promptAllow);
      runtime.applyPromptToolsAllow(["sessions_spawn", "github_publish"]);
      await spawn("publication-child");
      const policy = gatewayCreate.mock.calls[0]?.[0]?.creation?.inheritedToolPolicy;
      expect(policy.allow.includes("github_publish")).toBe(expected);
      expect(
        gatewayRuntimeIdentity.mock.calls[0]?.[1]?.sessionSpawnContext.inheritedToolPolicy.allow,
      ).toEqual(policy.allow);
      expect(placements.isWorkerTurnToolAuthorized(sourceClaim, "github_publish")).toBe(false);
      await runtime.close();
      expect(() => runtime.getInheritedPublicationToolName()).toThrow("Worker tool surface closed");
    },
  );

  it("rejects tool publication when the source run closes during preparation", async () => {
    const { identity } = f;
    const started = createDeferred();
    const prepared = createDeferred<AnyAgentTool[]>();
    const runtime = getFixture().createToolRuntime({
      prepareTools: () => {
        started.resolve();
        return prepared.promise;
      },
    });
    const pending = runtime.getSurface(identity);
    await started.promise;
    getFixture().closeSourceRun();
    prepared.resolve([]);
    await expect(pending).rejects.toThrow(/source worker run ended|worker turn authority changed/);
  });

  it.each([
    ["active", null],
    ["run-ended", /source worker run ended|agent tool caller authority is no longer/],
    ["operator-revoked", /operator.*(revoked|no longer active)/],
  ] as const)(
    "reads presence as the original operator only while its authority is live (%s)",
    async (authorityState, error) => {
      const { placements, sourceClaim } = f;
      await placements.authorizeWorkerTurnTools(sourceClaim, ["presence"]);
      const entered = createDeferred();
      const release = createDeferred();
      const snapshot = { status: "ok", people: [{ name: "Ada" }] };
      const query = { action: "person", person: "me", include: ["devices"] };
      gatewayRequest.mockImplementationOnce(async (request) => {
        expect(request).toMatchObject({
          method: "presence.query",
          params: query,
        });
        expect(request.params).not.toHaveProperty("toolCallId");
        expect(getGatewayToolCallerIdentity()?.operatorAuthority).toMatchObject({
          profileId: "profile-worker-requester",
          scopes: ["operator.write"],
        });
        entered.resolve();
        await release.promise;
        return snapshot;
      });
      const tool = (await f.createTools()).find(({ name }) => name === "presence")!;
      const pending = tool.execute("presence-read", structuredClone(query));
      await entered.promise;
      if (authorityState === "run-ended") {
        getFixture().closeSourceRun();
      } else if (authorityState === "operator-revoked") {
        getFixture().revokeOperatorAuthority();
      }
      release.resolve();
      if (error) {
        await expect(pending).rejects.toThrow(error);
      } else {
        expect((await pending).details).toEqual(snapshot);
        await placements.authorizeWorkerTurnTools(sourceClaim, []);
        await expect(tool.execute("revoked-presence", {})).rejects.toThrow(
          "Worker tool authority changed",
        );
      }
      expect(gatewayRequest).toHaveBeenCalledOnce();
    },
  );

  it("applies worker presence policy before querying the roster", async () => {
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    await placements.authorizeWorkerTurnTools(sourceClaim, ["presence"]);
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          matcher: ["presence"],
          handler: () => ({ block: true, blockReason: "presence is disabled here" }),
        },
      ]),
    );
    const tool = (await getFixture().createTools()).find(
      (candidate) => candidate.name === "presence",
    )!;
    const result = await tool.execute("blocked-presence", {});
    expect(result.details).toMatchObject({ reason: "presence is disabled here" });
    expect(gatewayRequest).not.toHaveBeenCalled();
  });

  it.each(["deny", "invalid rewrite"] as const)(
    "blocks a worker spawn before child effects and replays the policy decision (%s)",
    async (decision) => {
      const { spawn } = f;
      const receipts: DecisionReceiptV1[] = [];
      const clearReceipts = configureRuntimeActionDecisionSink((receipt) => {
        receipts.push(receipt);
        return true;
      });
      const reason =
        decision === "deny"
          ? "blocked by worker session policy"
          : "Tool call blocked because before_tool_call returned invalid sessions_spawn input.";
      const beforeToolCall = vi.fn(() =>
        decision === "deny"
          ? { block: true, blockReason: reason }
          : Promise.resolve({ params: { task: "" } }),
      );
      const afterToolCall = vi.fn();
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "after_tool_call", matcher: ["sessions_spawn"], handler: afterToolCall },
          { hookName: "before_tool_call", matcher: ["sessions_spawn"], handler: beforeToolCall },
        ]),
      );

      try {
        const first = await spawn("blocked-worker-spawn");
        const replay = await spawn("blocked-worker-spawn");
        expect(replay.resultJson).toBe(first.resultJson);
        expect(JSON.parse(first.resultJson)).toMatchObject({
          details: { status: "blocked", reason },
        });
        expect(beforeToolCall).toHaveBeenCalledOnce();
        expect(afterToolCall).toHaveBeenCalledOnce();
        if (decision === "deny") {
          expect(receipts).toHaveLength(1);
          expect(receipts[0]).toMatchObject({
            contextId: PARENT_EXECUTION_IDENTITY_TOKEN.contextId,
            executionId: PARENT_EXECUTION_IDENTITY_TOKEN.executionId,
            runId: PARENT_EXECUTION_IDENTITY_TOKEN.runId,
            action: { family: "plugin", operation: "before_tool_call" },
            decision: { outcome: "denied", reasonCode: "plugin_hook_blocked" },
            enforcement: { coverageState: "enforced" },
            source: { owner: "plugin-hook" },
          });
        }
        expect(gatewayCreate).not.toHaveBeenCalled();
        expect(dispatchChild).not.toHaveBeenCalled();
        expect(gatewayRequest).not.toHaveBeenCalled();
      } finally {
        clearReceipts();
      }
    },
  );

  it("retains Workshop replay, update, call-cap, and live-authority behavior in the generic surface", async () => {
    const { placements, sourceClaim } = f;
    await placements.authorizeWorkerTurnTools(sourceClaim, ["skill_workshop"]);
    const update = vi.fn();
    const beforeToolCall = vi.fn();
    const afterToolCall = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_tool_call", matcher: ["skill_workshop"], handler: beforeToolCall },
        { hookName: "after_tool_call", matcher: ["skill_workshop"], handler: afterToolCall },
      ]),
    );
    const executeWorkshop = vi.fn<AnyAgentTool["execute"]>(
      async (_id, _args, _signal, onUpdate) => {
        const result = { content: [{ type: "text" as const, text: "library" }], details: {} };
        onUpdate?.(result);
        return result;
      },
    );
    const tool = await workshop(executeWorkshop);
    const first = await tool.execute("call-0", { action: "list" }, undefined, update);
    expect(await tool.execute("call-0", { action: "list" })).toEqual(first);
    expect(executeWorkshop).toHaveBeenCalledOnce();
    expect(beforeToolCall).toHaveBeenCalledOnce();
    expect(afterToolCall).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce();
    await expect(tool.execute("call-0", { action: "read" })).rejects.toThrow("reused");
    for (let index = 1; index < 64; index += 1) {
      await tool.execute(`call-${index}`, { action: "list" });
    }
    await expect(tool.execute("call-64", { action: "list" })).rejects.toThrow("operation limit");
    getFixture().closeSourceRun();
    await expect(tool.execute("call-0", { action: "list" })).rejects.toThrow();
    expect(executeWorkshop).toHaveBeenCalledTimes(64);
  });

  registerWorkerGatewayToolExecutionTests(getFixture);

  it.each(["policy", "result"] as const)(
    "revalidates tool grants after awaited %s work",
    async (revokedAt) => {
      const { placements, sourceClaim } = f;
      await placements.authorizeWorkerTurnTools(sourceClaim, ["skill_workshop"]);
      if (revokedAt === "policy") {
        initializeGlobalHookRunner(
          createMockPluginRegistry([
            {
              hookName: "before_tool_call",
              matcher: ["skill_workshop"],
              handler: async () => {
                await Promise.resolve();
                await placements.authorizeWorkerTurnTools(sourceClaim, []);
              },
            },
          ]),
        );
      }
      const executeWorkshop = vi.fn<AnyAgentTool["execute"]>(async () => {
        await Promise.resolve();
        await placements.authorizeWorkerTurnTools(sourceClaim, []);
        return { content: [], details: {} };
      });
      const tool = await workshop(executeWorkshop);
      await expect(tool.execute("revoked-call", { action: "list" })).rejects.toThrow(
        "tool authority changed",
      );
      expect(executeWorkshop).toHaveBeenCalledTimes(revokedAt === "policy" ? 0 : 1);
    },
  );

  it.each([
    { name: "default", required: false, permissionMode: undefined },
    { name: "required isolation", required: true, permissionMode: undefined },
    { name: "read-only", required: false, permissionMode: "read-only" },
  ] as const)(
    "coalesces cloud spawns with inherited identity, permissions, and $name policy",
    async ({ required, permissionMode }) => {
      const { spawn, placements, sourceClaim, spawnState } = f;
      const creator = { type: "human", id: "profile-worker-creator" } as const;
      Object.assign(sessionEntries.get(SOURCE.sessionKey)!, {
        createdActor: creator,
        ...(required ? { sandbox: "required" as const } : {}),
        ...(permissionMode ? { permissionMode } : {}),
      });

      const create = gatewayCreate.getMockImplementation();
      assert(create, "missing session creation fixture");
      const createStarted = createDeferred();
      const finishCreate = createDeferred();
      gatewayCreate.mockImplementation(async (request) => {
        createStarted.resolve();
        await finishCreate.promise;
        return await create(request);
      });
      const retries = Array.from({ length: 32 }, () =>
        spawn("spawn-cloud-child", "run in the nested cloud session"),
      );
      await createStarted.promise;
      finishCreate.resolve();
      const results = await Promise.all(retries);
      expect(new Set(results.map((result) => result.resultJson))).toHaveLength(1);
      const first = results[0]!;
      const replay = await spawn("spawn-cloud-child", "run in the nested cloud session");

      expect(spawnState.childSessionKey).toMatch(/^agent:main:dashboard:cloud-[a-f0-9]{32}$/u);
      expect(spawnState.order).toEqual(["create", "dispatch", "send"]);
      expect(gatewayCreate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          creation: expect.objectContaining({
            actor: { type: "agent", id: SOURCE.agentId },
            requesterSessionKey: SOURCE.sessionKey,
            via: "spawn",
          }),
          method: "sessions.create",
          options: {
            resolveGatewayContext,
            sessionMutationCommitGuard: expect.any(Function),
            timeoutMs: null,
          },
          params: expect.not.objectContaining({ task: expect.anything() }),
        }),
      );
      expect(gatewayCreate.mock.calls[0]?.[0]?.creation?.sandbox).toBeUndefined();
      expect(dispatchChild).toHaveBeenCalledExactlyOnceWith(
        {
          sessionId: CHILD.sessionId,
          sessionKey: spawnState.childSessionKey,
          agentId: CHILD.agentId,
          executionMode: "worker-turn",
          profileId: "cloud-profile",
          inheritedProfile: {
            providerId: CLOUD_PROFILE.providerId,
            profileSnapshot: CLOUD_PROFILE.profileSnapshot,
          },
        },
        undefined,
        expect.any(Function),
      );
      expect(gatewayRequest).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentRunTracking: "native_subagent",
          method: "agent",
          params: expect.objectContaining({
            idempotencyKey: expect.stringMatching(/^worker-session-spawn:/u),
            message: "run in the nested cloud session",
            sessionId: CHILD.sessionId,
          }),
        }),
      );
      expect(spawnArgs).toHaveBeenCalledWith(
        expect.objectContaining({ expectsCompletionMessage: false, visible: true, worktree: true }),
      );
      expect(placements.get(CHILD.sessionId)?.state).toBe("active");
      expect(sessionEntries.get(spawnState.childSessionKey!)).toMatchObject({
        sessionId: CHILD.sessionId,
        parentSessionKey: SOURCE.sessionKey,
        parentSessionId: SOURCE.sessionId,
      });
      expect(replay.resultJson).toBe(first.resultJson);
      const createParams = gatewayCreate.mock.calls[0]?.[0]?.params;
      expect(createParams).toMatchObject({ worktree: true });
      if (permissionMode) {
        expect(createParams).toMatchObject({ permissionMode });
      } else {
        expect(createParams).not.toHaveProperty("permissionMode");
      }

      expect(spawnCallerIdentity).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: SOURCE.agentId,
          sessionKey: SOURCE.sessionKey,
          executionIdentityToken: PARENT_EXECUTION_IDENTITY_TOKEN,
          operationalRunInstance: expect.objectContaining({ runId: sourceClaim.runId }),
          operatorAuthority: expect.objectContaining({ profileId: "profile-worker-requester" }),
          receiptAuthority: expect.any(Function),
          workerTurnClaim: sourceClaim,
        }),
      );
      const runtimeIdentity = gatewayRuntimeIdentity.mock.calls[0]?.[1];
      expect(runtimeIdentity).toMatchObject({
        kind: "agentRuntime",
        agentId: SOURCE.agentId,
        sessionKey: SOURCE.sessionKey,
        executionIdentity: PARENT_EXECUTION_IDENTITY_TOKEN,
        operationalRunInstance: expect.objectContaining({ runId: sourceClaim.runId }),
        delegatedAuthority: expect.objectContaining({ kind: "worker", turnClaim: sourceClaim }),
        sessionSpawnContext: {
          inheritedToolPolicy: {
            version: 1,
            allow: ["sessions_spawn", "sessions_send"],
            deny: [],
          },
        },
      });
      expect(readAgentRuntimeExecutionLineage(runtimeIdentity?.sessionSpawnContext)).toMatchObject({
        relation: "sessions_spawn",
        requesterRef: SOURCE.sessionKey,
        controllerRef: SOURCE.sessionKey,
        depth: 1,
        externalNativeActions: "observable",
      });
      expect(JSON.stringify(gatewayRuntimeIdentity.mock.calls[0]?.[0])).not.toContain(
        PARENT_EXECUTION_IDENTITY_TOKEN.executionId,
      );
      expect(JSON.stringify(runtimeIdentity?.sessionSpawnContext)).not.toContain(SOURCE.sessionKey);
    },
  );

  it.each(["create", "dispatch", "send"] as const)(
    "recovers a lost child %s response without repeating committed effects",
    async (stage) => {
      const { spawn, placements, spawnState, activate } = f;
      const sendKeys: string[] = [];
      if (stage === "create") {
        loseCreationResponse();
      } else if (stage === "dispatch") {
        dispatchChild.mockImplementationOnce(async (request: { sessionKey: string }) => {
          spawnState.order.push("dispatch");
          await activate({ ...CHILD, sessionKey: request.sessionKey });
          throw new Error("cloud dispatch response was lost");
        });
      } else {
        gatewayRequest.mockImplementation(
          async (request: { method: string; params: Record<string, unknown> }) => {
            if (request.method !== "agent") {
              throw new Error(`Unexpected gateway request: ${request.method}`);
            }
            spawnState.order.push("send");
            sendKeys.push(String(request.params.idempotencyKey));
            if (sendKeys.length === 1) {
              throw new Error("initial task response was lost");
            }
            return { runId: "spawned-child-run", status: "accepted" };
          },
        );
      }
      const first = await spawn("spawn-response-loss");
      const replay = await spawn("spawn-response-loss");
      expect(first.resultJson).not.toContain('"status":"error"');
      expect(replay.resultJson).toBe(first.resultJson);
      expect(gatewayCreate).toHaveBeenCalledOnce();
      expect(placements.get(CHILD.sessionId)?.state).toBe("active");
      expect(spawnState.order).toEqual(
        stage === "send" ? ["create", "dispatch", "send", "send"] : ["create", "dispatch", "send"],
      );
      if (stage === "send") {
        expect(sendKeys).toHaveLength(2);
        expect(sendKeys[1]).toBe(sendKeys[0]);
      }
    },
  );

  it("spawns a grandchild from the child cloud turn and communicates across both levels", async () => {
    const { spawn, placements, spawnState, identity, execute, delegatedAuthorities } = f;
    await spawn("spawn-child-for-nesting");
    const spawnedChildKey = spawnState.childSessionKey!;
    async function admitDescendant(
      owner: typeof CHILD,
      sessionKey: string,
      name: string,
      createdAt: number,
      tools: string[],
    ) {
      const claim = await placements.claimTurn({
        sessionId: owner.sessionId,
        agentId: owner.agentId,
        sessionKey,
        claimId: `${name}-claim`,
        runId: `${name}-run`,
        owner: { kind: "worker", environmentId: owner.environmentId, ownerEpoch: owner.ownerEpoch },
      });
      await placements.authorizeWorkerTurnTools(claim, tools);
      const token = {
        ...PARENT_EXECUTION_IDENTITY_TOKEN,
        contextId: `${name}-context`,
        executionId: `${name}-execution`,
        runId: claim.runId,
        createdAt,
      } satisfies ExecutionIdentityAdmissionToken;
      const operationalRun = createOperationalRunInstanceRef(claim.runId);
      delegatedAuthorities.push(claimAgentRunDelegatedAuthority(operationalRun));
      await bindWorkerTurnOwner(
        placements,
        claim,
        token,
        operationalRun,
        {
          agentId: owner.agentId,
          sessionId: owner.sessionId,
          sessionKey,
          storePath: path.join(f.root, "sessions.json"),
        },
        () => {},
      );
      const connection: WorkerConnectionIdentity = {
        ...identity,
        environmentId: owner.environmentId,
        sessionId: owner.sessionId,
        runId: claim.runId,
        turnClaim: claim,
        ownerEpoch: owner.ownerEpoch,
      };
      return { connection, token };
    }
    const { connection: childIdentity, token: childExecutionIdentityToken } = await admitDescendant(
      CHILD,
      spawnedChildKey,
      "child",
      2,
      ["sessions_spawn", "sessions_send"],
    );
    getFixture().createToolRuntime({ identity: childIdentity });
    const grandchild = f.configureSpawnTarget(
      GRANDCHILD,
      {
        sessionKey: spawnedChildKey,
        sessionId: CHILD.sessionId,
      },
      "spawned-grandchild-run",
    );

    await execute({
      identity: childIdentity,
      toolName: "sessions_spawn",
      request: { toolCallId: "spawn-grandchild", task: "start the grandchild" },
    });
    expect(spawnCallerIdentity.mock.calls.map((call) => call[0]?.executionIdentityToken)).toEqual([
      PARENT_EXECUTION_IDENTITY_TOKEN,
      childExecutionIdentityToken,
    ]);
    expect(sessionEntries.get(grandchild.childSessionKey!)).toMatchObject({
      parentSessionKey: spawnedChildKey,
      parentSessionId: CHILD.sessionId,
      sessionId: GRANDCHILD.sessionId,
    });

    async function sendFrom(
      workerIdentity: WorkerConnectionIdentity,
      toolCallId: string,
      sessionKey: string,
    ) {
      const result = await execute({
        identity: workerIdentity,
        toolName: "sessions_send",
        request: { toolCallId, sessionKey, message: "status" },
      });
      expect(JSON.parse(result.resultJson)).toMatchObject({ details: { status: "ok" } });
    }
    await sendFrom(childIdentity, "child-to-root", SOURCE.sessionKey);
    const { connection: grandchildIdentity } = await admitDescendant(
      GRANDCHILD,
      grandchild.childSessionKey!,
      "grandchild",
      3,
      ["sessions_send"],
    );
    await sendFrom(grandchildIdentity, "grandchild-to-child", spawnedChildKey);

    expect(delivered).toHaveBeenCalledTimes(2);
    expect(delivered.mock.calls.map((call) => call[0].args.sessionKey)).toEqual([
      SOURCE.sessionKey,
      spawnedChildKey,
    ]);
  });

  it("records an unprovable post-create incarnation as unknown and releases the claim", async () => {
    const { spawn, placements, sourceClaim } = f;
    loseCreationResponse({
      sessionKey: "agent:main:dashboard:other-parent",
      sessionId: "other-parent-session",
    });
    const first = await spawn("spawn-unknown-owner");
    const replay = await spawn("spawn-unknown-owner");

    expect(first.resultJson).toContain("outcome is unknown");
    expect(replay.resultJson).toContain("prior operation outcome is unknown");
    expect(gatewayCreate).toHaveBeenCalledOnce();
    expect(gatewayRequest).not.toHaveBeenCalled();
    await expect(placements.releaseTurn(sourceClaim)).resolves.toMatchObject({ turnClaim: null });
  });
});

describe.each([
  presenceSource(
    "unverified",
    "Presence requires authenticated Gateway read access or a trusted operator source.",
  ),
  presenceSource("authenticated reader", undefined, {
    operatorProfileId: "profile-presence-reader",
    operatorScopes: ["operator.read"],
  }),
  presenceSource("session-only operator", "Presence requires operator.read access.", {
    operatorProfileId: "profile-session-reader",
    operatorScopes: ["operator.sessions.read"],
  }),
  presenceSource("operator schedule", undefined, { admissionSource: "operator-schedule" }),
  presenceSource(
    "requester schedule",
    "Presence requires authenticated Gateway read access or a trusted operator source.",
    {
      admissionSource: "requester-schedule",
    },
  ),
])("worker presence source authorization ($source)", (source) => {
  const getFixture = installWorkerSessionToolTestFixture(fixtureMocks, source);

  it("requires the source's read authority before querying the roster", async () => {
    const { placements, sourceClaim, setEntry, createTools } = getFixture();
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    await placements.authorizeWorkerTurnTools(sourceClaim, ["presence"]);
    const snapshot = { status: "ok", people: [{ name: "Ada" }] };
    gatewayRequest.mockResolvedValueOnce(snapshot);

    const tool = (await createTools()).find((candidate) => candidate.name === "presence")!;
    const pending = tool.execute("source-presence", { include: ["network", "location"] });

    if (source.deniedReason) {
      await expect(pending).rejects.toThrow(source.deniedReason);
      expect(gatewayRequest).not.toHaveBeenCalled();
    } else {
      expect((await pending).details).toEqual(snapshot);
      expect(gatewayRequest).toHaveBeenCalledOnce();
      if (source.admissionSource === "operator-schedule") {
        getFixture().closeSourceRun();
        await expect(tool.execute("closed-schedule", {})).rejects.toThrow(
          "worker turn authority changed",
        );
        expect(gatewayRequest).toHaveBeenCalledOnce();
      }
    }
  });
});

describe("worker spawn startup composition", () => {
  const getFixture = installWorkerSessionToolTestFixture(fixtureMocks);

  it.each([false, true])(
    "retains parent authority across runtime-bound provisioning (closed=%s)",
    async (closed) => {
      const { root, placements, identity, setEntry, activate, closeSourceRun } = getFixture();
      setEntry(SOURCE.sessionKey, SOURCE.sessionId);
      const { createDesktopSessionRegistry } = await import("../desktop/session-registry.js");
      const { createGatewayWorkerEnvironmentRuntime, loadGatewayWorkerEnvironmentStartupState } =
        await import("../server-worker-environment-startup.js");
      const factory = vi.spyOn(environmentServiceModule, "createWorkerEnvironmentService");
      try {
        await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
          const startup = await loadGatewayWorkerEnvironmentStartupState();
          const registry = createEmptyPluginRegistry();
          const runtime = await createGatewayWorkerEnvironmentRuntime({
            scheduler: createTestGatewayScheduler(),
            getPluginRegistry: () => registry,
            getPortalRuntime: () => undefined,
            resolveGatewayContext,
            desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
            startup: { ...startup, placementStore: placements },
            log: { child: () => ({ info: () => {}, warn: () => {} }) },
          });
          const service = runtime.workerEnvironmentService;
          const createTools = factory.mock.calls.at(-1)?.[0].createGatewayTools;
          assert(
            service && createTools && runtime.bindWorkerSessionDispatch,
            "worker session-tool runtime was not composed",
          );
          const base = service.get(SOURCE.environmentId);
          assert(base, "source environment fixture was not created");
          const getEnvironment = vi.spyOn(service, "get").mockImplementation((environmentId) => {
            const owner = environmentId === SOURCE.environmentId ? SOURCE : CHILD;
            return {
              ...base,
              environmentId,
              ...structuredClone(CLOUD_PROFILE),
              state: "attached",
              leaseId: `lease-${environmentId}`,
              ownerEpoch: owner.ownerEpoch,
              attachedSessionIds: [owner.sessionId],
            };
          });
          const provisioning = createDeferred();
          const finishProvisioning = createDeferred();
          runtime.bindWorkerSessionDispatch(async (request, _onTransition, authorize) => {
            provisioning.resolve();
            await finishProvisioning.promise;
            authorize?.();
            await activate({ ...CHILD, sessionKey: request.sessionKey });
            const placement = placements.get(CHILD.sessionId);
            assert(placement?.state === "active", "child fixture did not activate");
            return placement;
          });
          try {
            const tools = await createTools({ identity });
            const spawnTool = tools.find((tool) => tool.name === "sessions_spawn");
            assert(spawnTool, "Worker spawn tool was not composed");
            const pending = spawnTool.execute("startup-parent-closure", {
              task: "start the child",
            });
            await Promise.race([
              provisioning.promise,
              pending.then(() => {
                throw new Error("worker spawn completed before provisioning");
              }),
            ]);
            if (closed) {
              closeSourceRun();
            }
            finishProvisioning.resolve();
            if (closed) {
              await expect(pending).rejects.toThrow();
            } else {
              expect(JSON.stringify(await pending)).not.toContain('"status":"error"');
            }
            expect(placements.get(CHILD.sessionId)?.state).toBe(closed ? undefined : "active");
            expect(gatewayRequest).toHaveBeenCalledTimes(closed ? 0 : 1);
          } finally {
            finishProvisioning.resolve();
            getEnvironment.mockRestore();
            await service.stop();
          }
        });
      } finally {
        factory.mockRestore();
      }
    },
  );
});

registerWorkerDelegationPolicyTests(fixtureMocks);

describe.each([false, true])(
  "worker spawn parent authority (audit=%s)",
  (collectExecutionIdentity) => {
    const getFixture = installWorkerSessionToolTestFixture(fixtureMocks, {
      collectExecutionIdentity,
    });

    it.each([false, true])(
      "launches the child only while the parent owner is active (closed=%s)",
      async (closed) => {
        const { setEntry, spawn, placements, sourceClaim, closeSourceRun } = getFixture();
        setEntry(SOURCE.sessionKey, SOURCE.sessionId);
        const dispatch = dispatchChild.getMockImplementation();
        assert(dispatch, "Missing child placement fixture");
        const provisioning = createDeferred();
        const finishProvisioning = createDeferred();
        dispatchChild.mockImplementationOnce(async (...args) => {
          provisioning.resolve();
          await finishProvisioning.promise;
          return await dispatch(...args);
        });

        const pending = spawn("parent-closes-during-provisioning");
        await provisioning.promise;
        let drained: Promise<void> | undefined;
        if (closed) {
          closeSourceRun();
          drained = placements.closeWorkerTurnToolState(sourceClaim);
          // Parent teardown retains this claim until the admitted spawn settles.
          expect(placements.validateTurnClaim(sourceClaim)).toBe(true);
        }
        finishProvisioning.resolve();
        const result = await pending;
        await drained;

        expect(gatewayRequest).toHaveBeenCalledTimes(closed ? 0 : 1);
        expect(result.resultJson.includes('"status":"error"')).toBe(closed);
        expect(spawnCallerIdentity.mock.calls[0]?.[0]?.executionIdentityToken).toBe(
          collectExecutionIdentity ? PARENT_EXECUTION_IDENTITY_TOKEN : undefined,
        );
      },
    );
  },
);
