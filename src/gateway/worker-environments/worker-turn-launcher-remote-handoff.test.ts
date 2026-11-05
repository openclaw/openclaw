import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WorkerConnectRequestFrameSchema } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import {
  installSessionPlacementAdmissionProvider,
  withSessionPlacementTurnAdmission,
} from "../../agents/session-placement-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../../audit/execution-identity-admission.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { runWithoutOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context-store.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import {
  buildWorkerConnectParams,
  type WorkerLaunchDescriptor,
} from "../../worker/launch-descriptor.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { verifyAgentRuntimeIdentityToken } from "../agent-runtime-identity-token.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  completeTurn,
  createLauncher,
  installLauncherTest,
  environmentForTunnel,
  launchDescriptor,
  localResult,
  runIdentity,
} from "./worker-turn-launcher-flow.test-support.js";
import {
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  browserEnvironment,
  openSessionManager,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setWorkerTurnAdmissionCleanup,
  setWorkerTurnSessionTarget,
  turn,
} from "./worker-turn-launcher.test-support.js";

function wireUser(text: string, timestamp: number) {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function readCall(id: string, timestamp: number, stopReason: "stop" | "toolUse" = "stop") {
  return makeAgentAssistantMessage({
    content: [{ type: "toolCall", id, name: "read", arguments: {} }],
    timestamp,
    stopReason,
  });
}

async function verifyIdentity(assignment: WorkerLaunchDescriptor["assignment"]) {
  const identity = await verifyAgentRuntimeIdentityToken(assignment.agentRuntimeIdentityToken);
  expect(identity?.operationalRunInstance).toEqual(assignment.operationalRunInstance);
  return identity;
}

describe("worker turn launcher remote handoff", () => {
  installLauncherTest();
  afterEach(() => setActiveNodeContexts([]));

  it("settles a delegated worker reply and conflict without borrowing its parent transcript", async () => {
    setActiveNodeContexts([{ nodeId: "active-mac" }]);
    let admissionWork: ExecutionIdentityAdmissionWork | undefined;
    setWorkerTurnAdmissionCleanup(
      configureExecutionIdentityAdmissionSink((work) => {
        admissionWork = work;
        return true;
      }),
    );
    setWorkerTurnSessionTarget({
      ...sessionTarget,
      agentId: "worker-agent",
      sessionKey: "agent:worker-agent:worker-turn",
    });
    await upsertSessionEntryCore(sessionTarget, {
      sessionId: SESSION_ID,
      updatedAt: Date.now(),
    });
    const initialized = await runCommandWithTimeout(["git", "-C", root, "init", "--quiet"], {
      timeoutMs: 10_000,
    });
    expect(initialized.code).toBe(0);
    await seedActivePlacement();
    const manager = await openSessionManager();
    const earlierRequestId = await manager.appendMessageAsync(
      makeAgentUserMessage({ content: "Earlier request", timestamp: 10 }),
    );
    await manager.appendMessageAsync(readCall("call-1", 11));
    await manager.appendCustomMessageEntryAsync("context", "Custom durable context", true, {});
    await manager.appendCompactionAsync(
      "Compacted durable context",
      expectDefined(earlierRequestId, "persisted pre-compaction user entry"),
      100,
    );
    const toolResult = makeTextToolResult("call-1", "read", "result", false, 12);
    await manager.appendMessageAsync(toolResult);
    let descriptor: WorkerLaunchDescriptor | undefined;
    const environment = browserEnvironment();
    environment.desktop!.apps![0]!.args = ["-File", "C:\\ProgramData\\OpenClaw\\browser.ps1"];
    const bootstrapReceipt = expectDefined(environment.bootstrapReceipt, "bootstrap receipt");
    const acknowledgeCredentialDelivery = vi.fn(async () => true);
    const reconcileWorkspace = vi
      .fn<WorkerTunnelHandle["reconcileWorkspace"]>()
      .mockImplementationOnce(reconcileUnchangedLocalWorkspace)
      .mockImplementationOnce(
        async (request: Parameters<WorkerTunnelHandle["reconcileWorkspace"]>[0]) => {
          if (request.source.kind !== "local") {
            throw new Error("expected a local workspace source");
          }
          expect(request.source.stagedResult).toBeDefined();
          await request.source.stagedResult!.record(request.source.stagedResult!.ref);
          expect(await placements.listPendingWorkspaceResultsAsync()).toMatchObject([
            { stagedResultRef: request.source.stagedResult!.ref, workspaceAcceptedAtMs: null },
          ]);
          return {
            ...(await reconcileUnchangedLocalWorkspace(request)),
            getAppliedWorkspaceResult: () => ({
              manifestRef: MANIFEST_REF,
              manifest: { version: 1 as const, baseCommit: null, entries: [] },
              conflictPaths: ["src/local.ts"],
              verifyLocalStable: async () => {},
            }),
          };
        },
      );
    const tunnel: WorkerTunnelHandle = createWorkerTurnTunnel({
      quiesceWorkspace: vi.fn(async () => ({
        assertActive: vi.fn(async () => {}),
        resume: vi.fn(async () => {
          expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({
            owner: "worker",
            runId: "run-worker-turn",
          });
          expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
        }),
      })),
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        expect(placements.get(SESSION_ID)?.turnClaim).toMatchObject({
          owner: "worker",
          runId: "run-worker-turn",
          ownerEpoch: OWNER_EPOCH,
        });
        descriptor = launchDescriptor(request.plan);
        expect(
          Value.Check(WorkerConnectRequestFrameSchema, {
            type: "req",
            id: "launch-validation",
            method: "connect",
            params: buildWorkerConnectParams(descriptor),
          }),
        ).toBe(true);
        expect(descriptor.admission.handshake).toEqual({
          bundleHash: bootstrapReceipt.bundleHash,
          openclawVersion: bootstrapReceipt.openclawVersion,
          protocolFeatures: bootstrapReceipt.protocolFeatures,
        });
        expect(descriptor.admission.handshake).not.toHaveProperty("installKind");
        expect(request.timeoutMs).toBe(5_000);
        const activeRuntimeIdentity = await verifyAgentRuntimeIdentityToken(
          descriptor.assignment.agentRuntimeIdentityToken,
        );
        expect(activeRuntimeIdentity?.delegatedAuthority.kind).toBe("worker");
        expect(
          activeRuntimeIdentity &&
            createAgentRuntimeApprovalAuthorityValidator(placements)(activeRuntimeIdentity),
        ).toBe(true);
        expect(acknowledgeCredentialDelivery).not.toHaveBeenCalled();
        request.onDispatchReady?.();
        expect(acknowledgeCredentialDelivery).toHaveBeenCalledOnce();
        // Remote commits arrive on their own RPC context, outside the launching tool.
        return runWithoutOwnedSessionTranscriptWrites(async () => {
          return completeTurn(request, "Worker reply", 21);
        });
      }),
      reconcileWorkspace,
    });
    const environments = environmentForTunnel({
      get: vi.fn(() => environment),
      acknowledgeCredentialDelivery,
      startTunnel: vi.fn(async () => tunnel),
    });
    const preparingWorkspace = createDeferred();
    const resumePreparation = createDeferred();
    const resolveWorkspace = vi.fn(async () => {
      preparingWorkspace.resolve();
      await resumePreparation.promise;
      return { kind: "local" as const, path: root };
    });
    const provider = createLauncher({
      environments,
      resolveWorkspace,
      reconcileActivePlacement: async () => {},
    });
    const runLocal = vi.fn(localResult);
    const onAgentEvent = vi.fn(() => {
      throw new Error("supplemental event failed");
    });

    onTestFinished(installSessionPlacementAdmissionProvider(provider));
    const input = turn("run-worker-turn", true);
    onTestFinished(() => input.preparedRunAdmission.close());
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined, config: input.config },
      input: { text: "Canonical transcript request" },
    });
    await recorder.persistApproved();
    const parentTarget = {
      ...sessionTarget,
      sessionId: "parent-session",
      sessionKey: "agent:worker-agent:parent",
    };
    await upsertSessionEntryCore(parentTarget, {
      sessionId: parentTarget.sessionId,
      activeWriterRunId: "parent-run",
      updatedAt: 1,
    });
    const parent = await SessionManager.openAsync(parentTarget);
    await parent.appendMessageAsync(makeAgentUserMessage({ content: "Delegate this task" }));
    const parentEntries = parent.getPersistedEntries();
    const preparationStartedAtMs = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(preparationStartedAtMs);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const execution = withOwnedSessionTranscriptWrites(
      {
        sessionTarget: { ...parentTarget, expectedWriterRunId: "parent-run" },
        assertCommitAllowed: () => {},
        withTranscriptWrite: async (write) => await write(),
      },
      () =>
        withSessionPlacementTurnAdmission(
          runIdentity(input.runId),
          {
            ...input,
            userTurnTranscriptRecorder: recorder,
            gatewayUiCommandTarget: { connId: "requesting-ui", profileId: "requester" },
            toolsAllow: ["browser"],
            workspaceDir: path.join(root, "stale-caller-workspace"),
            transcriptPrompt: "Canonical transcript request",
            extraSystemPrompt: "Keep the worker guidance.",
            onAgentEvent,
          },
          runLocal,
        ),
    );
    let result: Awaited<typeof execution>;
    try {
      await awaitGateBeforeSettlement(
        preparingWorkspace.promise,
        execution,
        "Worker settled before workspace preparation",
      );
      // Descriptor timeout belongs to worker execution, not host preparation.
      clock.mockReturnValue(preparationStartedAtMs + 6_000);
      await vi.advanceTimersByTimeAsync(1_000);
      resumePreparation.resolve();
      vi.useRealTimers();
      result = await execution;
    } finally {
      resumePreparation.resolve();
      vi.useRealTimers();
      await execution.catch(() => {});
      clock.mockRestore();
    }
    expect(result.payloads).toEqual([{ text: "Worker reply" }]);
    await waitForSessionRunEnd(SESSION_ID, null);
    expect((await SessionManager.openAsync(parentTarget)).getPersistedEntries()).toEqual(
      parentEntries,
    );
    expect(runLocal).not.toHaveBeenCalled();
    const conflictSummary =
      "Cloud result applied with 1 conflict(s); kept local versions: src/local.ts. Cloud versions staged at refs/openclaw/worker-results/";
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    expect(placements.get(SESSION_ID)?.workspaceResultConflict).toMatchObject({
      paths: ["src/local.ts"],
      stagedResultRef: expect.stringMatching(/^refs\/openclaw\/worker-results\//u),
    });
    expect(reconcileWorkspace).toHaveBeenCalledTimes(2);
    expect(onAgentEvent).not.toHaveBeenCalled();
    const entries = (await openSessionManager()).getBranch();
    const conflictIndex = entries.findIndex(
      (entry) => entry.type === "custom_message" && entry.customType === "cloud-workspace-conflict",
    );
    expect(entries[conflictIndex]).toMatchObject({
      type: "custom_message",
      content: expect.stringContaining(conflictSummary),
      display: true,
    });
    expect(conflictIndex).toBeGreaterThan(
      entries.findLastIndex(
        (entry) => entry.type === "message" && entry.message.role === "assistant",
      ),
    );
    const assignment = expectDefined(descriptor, "worker launch descriptor").assignment;
    expect(descriptor).toMatchObject({
      assignment: {
        prompt: expect.stringMatching(/^\[[^\]]+\] Inspect this workspace$/u),
        suppressPromptTranscript: true,
        agentId: sessionTarget.agentId,
      },
    });
    const systemPrompt = assignment.systemPrompt;
    expect(systemPrompt).toContain("You are a personal assistant running inside OpenClaw.");
    expect(systemPrompt).toContain("Keep the worker guidance.");
    expect(systemPrompt).toContain("active_node=active-mac");
    expect(systemPrompt).toContain("active_node_identity=unknown");
    expect(systemPrompt).toContain("Working directory: /worker/workspace");
    const verifiedRuntimeIdentity = await verifyIdentity(assignment);
    expect(verifiedRuntimeIdentity).toMatchObject({
      agentId: sessionTarget.agentId,
      sessionKey: sessionTarget.sessionKey,
      turnSourceChannel: "telegram",
      turnSourceTo: "chat-worker",
      turnSourceAccountId: "worker-account",
      turnSourceThreadId: "thread-worker",
      gatewayUiCommandTarget: { connId: "requesting-ui", profileId: "requester" },
      executionIdentity: { runId: "run-worker-turn" },
    });
    expect(
      verifiedRuntimeIdentity &&
        createAgentRuntimeApprovalAuthorityValidator(placements)(verifiedRuntimeIdentity),
    ).toBe(false);
    expect(admissionWork?.kind).toBe("capture");
    if (admissionWork?.kind === "capture") {
      expect(admissionWork.envelope.runtimeInstanceId).toBe(ENVIRONMENT_ID);
    }
    expect(verifiedRuntimeIdentity).not.toHaveProperty("approvalOwnerPluginId");
    expect(assignment).not.toHaveProperty("admittedRunContext");
    expect(assignment).not.toHaveProperty("gatewayUiCommandTarget");
    expect(assignment.toolAuthority.allowedToolNames).toEqual(["browser"]);
    expect(assignment.browser).toEqual({
      cdpUrl: "http://127.0.0.1:9222",
      launcherPath: "/usr/local/bin/openclaw-worker-browser",
      launcherArgs: ["-File", "C:\\ProgramData\\OpenClaw\\browser.ps1"],
    });
    expect(assignment.initialMessages).toEqual([
      wireUser(expect.stringContaining("Compacted durable context"), expect.any(Number)),
      wireUser(expect.stringMatching(/^\[[^\]]+\] Earlier request$/u), 10),
      expect.objectContaining({ role: "assistant" }),
      toolResult,
      wireUser("Custom durable context", expect.any(Number)),
    ]);
    expect(
      (await openSessionManager())
        .getEntries()
        .flatMap((entry) =>
          entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : [],
        ),
    ).toContain("Canonical transcript request");
  });

  it("keeps reset tool pairs valid without replaying the already-persisted current user", async () => {
    setActiveNodeContexts([{ nodeId: "disconnected-mac", isCurrent: () => false }]);
    await seedActivePlacement();
    const manager = await openSessionManager();
    await manager.appendMessageAsync(readCall("shared-call", 16, "toolUse"));
    const firstKeptEntryId = await manager.appendMessageAsync(
      makeAgentUserMessage({ content: "Earlier request", timestamp: 17 }),
    );
    await manager.appendMessageAsync(
      makeTextToolResult("shared-call", "read", "Discarded owner result", false, 18),
    );
    await manager.appendMessageAsync(readCall("shared-call", 19, "toolUse"));
    await manager.appendMessageAsync(
      makeTextToolResult("shared-call", "read", "Kept owner result", false, 20),
    );
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "Earlier reply" }],
        timestamp: 21,
      }),
    );
    await manager.appendResetBoundaryAsync("new", firstKeptEntryId);
    await manager.appendMessageAsync(
      makeAgentUserMessage({ content: "Inspect this workspace", timestamp: 22 }),
    );
    let descriptor: WorkerLaunchDescriptor | undefined;
    const tunnel: WorkerTunnelHandle = createWorkerTurnTunnel({
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        request.onDispatchReady?.();
        descriptor = launchDescriptor(request.plan);
        return completeTurn(request, "Worker reply", 21);
      }),
      reconcileWorkspace: vi.fn(reconcileUnchangedLocalWorkspace),
    });
    const environments = environmentForTunnel({
      get: vi.fn(() => browserEnvironment()),
      startTunnel: vi.fn(async () => tunnel),
    });
    const provider = createLauncher({ environments });

    await provider.executeTurn(
      runIdentity("run-persisted-user"),
      {
        ...turn("run-persisted-user"),
        config: {
          ...turn("run-persisted-user").config,
          plugins: { entries: { browser: { enabled: false } } },
        },
        toolsAllow: ["browser"],
        suppressNextUserMessagePersistence: true,
      },
      localResult,
    );

    const assignment = expectDefined(descriptor, "worker launch descriptor").assignment;
    expect(assignment.prompt).toContain("Inspect this workspace");
    expect(assignment.systemPrompt).toContain("active_node=unknown");
    expect(assignment.systemPrompt).toContain("active_node_identity=unknown");
    expect(assignment.systemPrompt).not.toContain("disconnected-mac");
    const verifiedRuntimeIdentity = await verifyIdentity(assignment);
    expect(verifiedRuntimeIdentity).not.toHaveProperty("executionIdentity");
    expect(verifiedRuntimeIdentity).not.toHaveProperty("approvalOwnerPluginId");
    expect(assignment.toolAuthority.allowedToolNames).toEqual([]);
    expect(assignment.browser).toBeUndefined();
    expect(assignment.initialMessages).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [{ id: "shared-call" }] },
      { role: "toolResult", toolCallId: "shared-call" },
      { role: "assistant" },
    ]);
    expect(JSON.stringify(assignment.initialMessages)).not.toContain("Discarded owner result");
    const persistedEntries = (await openSessionManager()).getEntries();
    const persistedCurrentUsers = persistedEntries.filter(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "user" &&
        (entry.message.content === "Inspect this workspace" ||
          (Array.isArray(entry.message.content) &&
            entry.message.content.some(
              (part) => part.type === "text" && part.text === "Inspect this workspace",
            ))),
    );
    expect(persistedCurrentUsers).toHaveLength(1);
  });
});
