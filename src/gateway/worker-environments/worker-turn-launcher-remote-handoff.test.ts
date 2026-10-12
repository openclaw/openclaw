import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { Value } from "typebox/value";
import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WorkerConnectRequestFrameSchema } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
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
import {
  runWithoutOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites,
} from "../../config/sessions/transcript-write-context.js";
import { setActiveNodeContexts } from "../../infra/active-node-context.js";
import { saveMediaBuffer } from "../../media/store.js";
import { runCommandWithTimeout, type SpawnResult } from "../../process/exec.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import {
  buildWorkerConnectParams,
  parseWorkerLaunchDescriptor,
  type WorkerLaunchDescriptor,
} from "../../worker/launch-descriptor.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { verifyAgentRuntimeIdentityToken } from "../agent-runtime-identity-token.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  acknowledgeCompletedWorkerTurn,
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  SESSION_KEY,
  attachedEnvironment,
  browserEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  openSessionManager,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setWorkerTurnAdmissionCleanup,
  setWorkerTurnSessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);

describe("worker turn launcher remote handoff", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));
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
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
        timestamp: 11,
      }),
    );
    await manager.appendCustomMessageEntryAsync("context", "Custom durable context", true, {});
    await manager.appendCompactionAsync(
      "Compacted durable context",
      expectDefined(earlierRequestId, "persisted pre-compaction user entry"),
      100,
    );
    await manager.appendMessageAsync(makeTextToolResult("call-1", "read", "result", false, 12));
    let descriptor: WorkerLaunchDescriptor | undefined;
    const environment = browserEnvironment();
    environment.desktop!.apps![0]!.args = ["-File", "C:\\ProgramData\\OpenClaw\\browser.ps1"];
    const bootstrapReceipt = environment.bootstrapReceipt;
    if (!bootstrapReceipt) {
      throw new Error("expected bootstrap receipt");
    }
    const acknowledgeCredentialDelivery = vi.fn(async () => true);
    const reconcileWorkspace = vi.fn(
      async (request: Parameters<WorkerTunnelHandle["reconcileWorkspace"]>[0]) => {
        if (request.source.kind !== "local") {
          throw new Error("expected a local workspace source");
        }
        expect(request.source.stagedResult).toBeDefined();
        await request.source.stagedResult!.record(request.source.stagedResult!.ref);
        expect(await placements.listPendingWorkspaceResultsAsync()).toMatchObject([
          { stagedResultRef: request.source.stagedResult!.ref, workspaceAcceptedAtMs: null },
        ]);
        await request.source.journal.commit(MANIFEST_REF);
        return {
          manifestRef: MANIFEST_REF,
          changed: false,
          verifyStable: async () => {},
          verifyLocalStable: async () => {},
          publishStagedResult: async () => {},
          discardPreparedStagedResult: async () => {},
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
        descriptor = parseWorkerLaunchDescriptor({
          ...structuredClone(request.plan),
          connectionEndpoint: {
            kind: "unix",
            socketPath: "/worker/gateway.sock",
          },
        });
        const connectFrame = {
          type: "req" as const,
          id: "launch-validation",
          method: "connect" as const,
          params: buildWorkerConnectParams(descriptor),
        };
        expect(Value.Check(WorkerConnectRequestFrameSchema, connectFrame)).toBe(true);
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
        expect(descriptor.connectionEndpoint).toEqual({
          kind: "unix",
          socketPath: "/worker/gateway.sock",
        });
        expect(acknowledgeCredentialDelivery).not.toHaveBeenCalled();
        request.onDispatchReady?.();
        expect(acknowledgeCredentialDelivery).toHaveBeenCalledOnce();
        // Remote commits arrive on their own RPC context, outside the launching tool.
        return runWithoutOwnedSessionTranscriptWrites(async () => {
          const completed = await openSessionManager();
          const leafId = await completed.appendMessageAsync(
            makeAgentAssistantMessage({
              content: [{ type: "text", text: "Worker reply" }],
              timestamp: 21,
            }),
          );
          return acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
        });
      }),
      reconcileWorkspace,
    });
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => environment),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery,
      startTunnel: vi.fn(async () => tunnel),
      stopTunnel: vi.fn(async () => {}),
      destroy: vi.fn(async () => attachedEnvironment()),
    };
    const resolveWorkspace = vi.fn(async () => ({ kind: "local" as const, path: root }));
    const provider = createWorkerSessionTurnPlacementProvider({
      environments,
      placements,
      resolveWorkspace,
      reconcileActivePlacement: async () => {},
    });
    const runLocal = vi.fn(async () => ({ meta: { durationMs: 1 } }));
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
    const result = await withOwnedSessionTranscriptWrites(
      {
        sessionTarget: { ...parentTarget, expectedWriterRunId: "parent-run" },
        assertCommitAllowed: () => {},
        withTranscriptWrite: async (write) => await write(),
      },
      () =>
        withSessionPlacementTurnAdmission(
          {
            sessionId: SESSION_ID,
            sessionKey: sessionTarget.sessionKey,
            agentId: sessionTarget.agentId,
            runId: input.runId,
          },
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
    expect((await SessionManager.openAsync(parentTarget)).getPersistedEntries()).toEqual(
      parentEntries,
    );

    expect(runLocal).not.toHaveBeenCalled();
    expect(resolveWorkspace).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      sessionKey: sessionTarget.sessionKey,
      agentId: sessionTarget.agentId,
    });
    expect(reconcileWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ source: expect.objectContaining({ kind: "local", path: root }) }),
    );
    const conflictSummary =
      "Cloud result applied with 1 conflict(s); kept local versions: src/local.ts. Cloud versions staged at refs/openclaw/worker-results/";
    expect(result.payloads).toEqual([
      { text: expect.stringContaining(`Worker reply\n\n${conflictSummary}`) },
    ]);
    expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
    expect(placements.get(SESSION_ID)?.workspaceResultConflict).toMatchObject({
      paths: ["src/local.ts"],
      stagedResultRef: expect.stringMatching(/^refs\/openclaw\/worker-results\//u),
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "assistant",
      data: {
        text: expect.stringContaining(conflictSummary),
        delta: expect.stringContaining(conflictSummary),
      },
    });
    expect(
      (await openSessionManager())
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom_message" && entry.customType === "cloud-workspace-conflict",
        ),
    ).toBe(true);
    expect(descriptor?.assignment.prompt).toMatch(/^\[[^\]]+\] Inspect this workspace$/u);
    const systemPrompt = descriptor?.assignment.systemPrompt;
    expect(systemPrompt).toContain("You are a personal assistant running inside OpenClaw.");
    expect(systemPrompt).toContain("Keep the worker guidance.");
    expect(systemPrompt).toContain("active_node=active-mac");
    expect(systemPrompt).toContain("active_node_identity=unknown");
    expect(systemPrompt).toContain("Working directory: /worker/workspace");
    expect(descriptor?.assignment.suppressPromptTranscript).toBe(true);
    expect(descriptor?.assignment.agentId).toBe(sessionTarget.agentId);
    expect(descriptor?.version).toBe(4);
    const verifiedRuntimeIdentity = await verifyAgentRuntimeIdentityToken(
      descriptor?.assignment.agentRuntimeIdentityToken,
    );
    expect(verifiedRuntimeIdentity?.operationalRunInstance).toEqual(
      descriptor?.assignment.operationalRunInstance,
    );
    expect(verifiedRuntimeIdentity?.executionIdentity?.runId).toBe("run-worker-turn");
    expect(verifiedRuntimeIdentity).toMatchObject({
      agentId: sessionTarget.agentId,
      sessionKey: sessionTarget.sessionKey,
      turnSourceChannel: "telegram",
      turnSourceTo: "chat-worker",
      turnSourceAccountId: "worker-account",
      turnSourceThreadId: "thread-worker",
      gatewayUiCommandTarget: { connId: "requesting-ui", profileId: "requester" },
    });
    expect(descriptor?.assignment.agentId).toBe(verifiedRuntimeIdentity?.agentId);
    expect(
      verifiedRuntimeIdentity &&
        createAgentRuntimeApprovalAuthorityValidator(placements)(verifiedRuntimeIdentity),
    ).toBe(false);
    expect(admissionWork?.kind).toBe("capture");
    if (admissionWork?.kind === "capture") {
      expect(admissionWork.envelope.runtimeInstanceId).toBe(ENVIRONMENT_ID);
    }
    expect(verifiedRuntimeIdentity).not.toHaveProperty("approvalOwnerPluginId");
    expect(descriptor?.assignment).not.toHaveProperty("admittedRunContext");
    expect(descriptor?.assignment).not.toHaveProperty("gatewayUiCommandTarget");
    expect(descriptor?.assignment.toolAuthority.allowedToolNames).toEqual(["browser"]);
    expect(descriptor?.assignment.browser).toEqual({
      cdpUrl: "http://127.0.0.1:9222",
      launcherPath: "/usr/local/bin/openclaw-worker-browser",
      launcherArgs: ["-File", "C:\\ProgramData\\OpenClaw\\browser.ps1"],
    });
    expect(descriptor?.assignment.initialMessages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: expect.stringContaining("Compacted durable context"),
          },
        ],
        timestamp: expect.any(Number),
      },
      {
        role: "user",
        content: [{ type: "text", text: expect.stringMatching(/^\[[^\]]+\] Earlier request$/u) }],
        timestamp: 10,
      },
      expect.objectContaining({ role: "assistant" }),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 12,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Custom durable context" }],
        timestamp: expect.any(Number),
      },
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
    const remote = path.join(await realpath(root), "remote");
    await mkdir(remote);
    await seedActivePlacement("worker-turn", remote);
    const image = {
      type: "image" as const,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAsTAAALEwEAmpwYAAAADUlEQVR4nGP4////KwAJ5gPoxLp9owAAAABJRU5ErkJggg==",
      mimeType: "image/png",
    };
    const inlineImages = [
      { ...image, sourceIndex: 0 },
      { ...image, sourceIndex: 2 },
    ];
    const savedImage = await saveMediaBuffer(
      Buffer.from(image.data, "base64"),
      "image/png",
      "inbound",
      5_000,
      "offloaded.png",
    );
    const imagePath = savedImage.path;
    const manager = await openSessionManager();
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "shared-call", name: "read", arguments: {} }],
        stopReason: "toolUse",
        timestamp: 16,
      }),
    );
    const firstKeptEntryId = await manager.appendMessageAsync(
      makeAgentUserMessage({ content: "Earlier request", timestamp: 17 }),
    );
    await manager.appendMessageAsync(
      makeTextToolResult("shared-call", "read", "Discarded owner result", false, 18),
    );
    await manager.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "shared-call", name: "read", arguments: {} }],
        stopReason: "toolUse",
        timestamp: 19,
      }),
    );
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
      runWorkspaceCommand: vi.fn(
        async (command) =>
          await runCommandWithTimeout([...command.argv], {
            cwd: remote,
            input: command.input,
            timeoutMs: 5_000,
            signal: command.signal,
          }),
      ),
      stageAttachments: vi.fn(async () => {}),
      launchTurn: vi.fn(async (request): Promise<SpawnResult> => {
        request.onDispatchReady?.();
        descriptor = parseWorkerLaunchDescriptor({
          ...structuredClone(request.plan),
          connectionEndpoint: {
            kind: "unix",
            socketPath: "/worker/gateway.sock",
          },
        });
        const completed = await openSessionManager();
        const leafId = await completed.appendMessageAsync(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "Worker reply" }],
            timestamp: 21,
          }),
        );
        return acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
      }),
      reconcileWorkspace: vi.fn(reconcileUnchangedLocalWorkspace),
    });
    const environments: WorkerTurnEnvironmentService = {
      get: vi.fn(() => browserEnvironment()),
      acquireTurnCredential: vi.fn(async () => credential()),
      acknowledgeCredentialDelivery: vi.fn(async () => true),
      startTunnel: vi.fn(async () => tunnel),
      stopTunnel: vi.fn(async () => {}),
      destroy: vi.fn(async () => attachedEnvironment()),
    };
    const provider = createWorkerSessionTurnPlacementProvider({ environments, placements });

    await provider.executeTurn(
      {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
        agentId: "main",
        runId: "run-persisted-user",
      },
      {
        ...turn("run-persisted-user"),
        config: {
          ...turn("run-persisted-user").config,
          plugins: { entries: { browser: { enabled: false } } },
        },
        toolsAllow: ["browser"],
        suppressNextUserMessagePersistence: true,
        images: inlineImages,
        imageOrder: ["inline", "offloaded", "inline"],
        media: [{ path: imagePath, contentType: "image/png", kind: "image" }],
      },
      async () => ({ meta: { durationMs: 1 } }),
    );

    expect(descriptor?.assignment.prompt).toEqual([
      { type: "text", text: expect.stringContaining("Inspect this workspace") },
      image,
      image,
      image,
    ]);
    expect(JSON.stringify(descriptor?.assignment.prompt)).toContain(
      "media/inbound/openclaw-staged-",
    );
    expect(tunnel.stageAttachments).toHaveBeenCalledOnce();
    expect(descriptor?.assignment.systemPrompt).toContain(
      "You are a personal assistant running inside OpenClaw.",
    );
    expect(descriptor?.assignment.systemPrompt).toContain("active_node=unknown");
    expect(descriptor?.assignment.systemPrompt).toContain("active_node_identity=unknown");
    expect(descriptor?.assignment.systemPrompt).not.toContain("disconnected-mac");
    const verifiedRuntimeIdentity = await verifyAgentRuntimeIdentityToken(
      descriptor?.assignment.agentRuntimeIdentityToken,
    );
    expect(verifiedRuntimeIdentity?.operationalRunInstance).toEqual(
      descriptor?.assignment.operationalRunInstance,
    );
    expect(verifiedRuntimeIdentity).not.toHaveProperty("executionIdentity");
    expect(verifiedRuntimeIdentity).not.toHaveProperty("approvalOwnerPluginId");
    expect(descriptor?.assignment.toolAuthority.allowedToolNames).toEqual([]);
    expect(descriptor?.assignment.browser).toBeUndefined();
    expect(descriptor?.assignment.initialMessages).toMatchObject([
      { role: "user" },
      { role: "assistant", content: [{ id: "shared-call" }] },
      { role: "toolResult", toolCallId: "shared-call" },
      { role: "assistant" },
    ]);
    expect(JSON.stringify(descriptor?.assignment.initialMessages)).not.toContain(
      "Discarded owner result",
    );
    const persistedEntries = (await openSessionManager()).getEntries();
    const persistedCurrentUsers = persistedEntries.filter((entry) => {
      if (typeof entry !== "object" || entry === null || !("message" in entry)) {
        return false;
      }
      const message = entry.message;
      if (
        typeof message !== "object" ||
        message === null ||
        !("role" in message) ||
        !("content" in message)
      ) {
        return false;
      }
      return (
        message.role === "user" &&
        (message.content === "Inspect this workspace" ||
          (Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                typeof part === "object" &&
                part !== null &&
                "text" in part &&
                part.text === "Inspect this workspace",
            )))
      );
    });
    expect(persistedCurrentUsers).toHaveLength(1);
  });
});
