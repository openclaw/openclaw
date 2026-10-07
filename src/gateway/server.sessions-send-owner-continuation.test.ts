import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import { prepareAgentCommandExecutionIdentity } from "../agents/agent-command-execution-identity.js";
import { buildAgentRunTerminalReplySnapshot } from "../agents/agent-run-terminal-reply.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../agents/cron-creator-authority-context.js";
import * as completionDelivery from "../agents/subagents/announce/subagent-announce-completion-delivery.js";
import { SessionFollowupCompletion } from "../agents/subagents/completion/session-followup-completion.js";
import { revokeRequesterCronAuthority } from "../agents/subagents/requester-cron-authority.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { isConfiguredCommandOwner } from "../auto-reply/command-auth.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { publishSystemEventStoreConfig } from "../config/sessions/session-store-path.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-selection.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  agentCommandMock,
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  startTestGatewayServer,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

const { createOpenClawTools } = await import("../agents/openclaw-tools.js");
const { resolveOpenClawPluginToolsForOptions } = await import("../agents/openclaw-plugin-tools.js");

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const root of tempDirs.dirs) {
      await releaseGatewaySessionStoreFixture(root);
    }
    cleanup();
  }),
);
let server: Awaited<ReturnType<typeof startTestGatewayServer>>;
let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
beforeAll(async () => {
  const module = await import("./server-kernel.js");
  const create = module.createGatewayKernel;
  const capture = vi.spyOn(module, "createGatewayKernel").mockImplementation(async (...args) => {
    kernel = await create(...args);
    return kernel;
  });
  try {
    server = await startTestGatewayServer(await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }));
  } finally {
    capture.mockRestore();
  }
});
afterAll(async () => {
  await server.close();
});

it.for(["success", "child error", "owner revoked", "new user turn"] as const)(
  "enforces owner authority at the final plugin write after an inline wait expires (%s)",
  async (outcome, { signal }) => {
    const root = tempDirs.make("openclaw-followup-owner-");
    const parent = "agent:main:main";
    const child = "agent:main:subagent:owner-proof";
    const parentId = "owner-proof-parent";
    const originalRun = "owner-proof-original";
    const effectPath = path.join(root, "effect.txt");
    testState.sessionStorePath = path.join(root, "sessions.json");
    await writeSessionStore({
      entries: {
        [parent]: { sessionId: parentId, updatedAt: 1 },
        [child]: { sessionId: "owner-proof-child", spawnedBy: parent, spawnDepth: 1, updatedAt: 1 },
      },
    });
    await prepareGatewayReplyRuntimeForTest();
    const config = { ...getRuntimeConfig(), commands: { ownerAllowFrom: ["discord:owner-proof"] } };
    setRuntimeConfigSnapshot(config);
    publishSystemEventStoreConfig(config);
    const owner = {
      senderId: "owner-proof",
      channel: "discord",
      accountId: "default",
      isCurrent: () =>
        isConfiguredCommandOwner(getRuntimeConfig(), {
          channel: "discord",
          senderId: "owner-proof",
        }),
    };
    expect(owner.isCurrent()).toBe(true);
    const childMayFinish = createDeferred();
    const pluginEntered = createDeferred();
    const effectMayFinish = createDeferred();
    const parentFinished = createDeferred();
    const inlineWaitStarted = createDeferred();
    const requesterAccepted = createDeferred();
    const completionClosed = createDeferred();
    let closeCompletion: (() => void) | undefined;
    let requesterReceipt: unknown;
    const onCompletionClosed = () => completionClosed.resolve();
    const observeInlineWait = vi
      .spyOn(SessionFollowupCompletion.prototype, "take")
      .mockImplementationOnce(function (this: SessionFollowupCompletion, timeoutMs) {
        observeInlineWait.mockRestore();
        const pending = this.take(timeoutMs);
        if (timeoutMs !== undefined) {
          this.signal.addEventListener("abort", onCompletionClosed, { once: true });
          closeCompletion = () => {
            this.close();
            this.signal.removeEventListener("abort", onCompletionClosed);
          };
          inlineWaitStarted.resolve();
        }
        return pending;
      });
    const dispatch = completionDelivery.runAnnounceAgentCall;
    const observeRequesterAdmission = vi
      .spyOn(completionDelivery, "runAnnounceAgentCall")
      .mockImplementation((params) =>
        dispatch({
          ...params,
          onAccepted: (receipt) => {
            params.onAccepted?.(receipt);
            requesterAccepted.resolve();
          },
        }).then((receipt) => {
          requesterReceipt = receipt;
          return receipt;
        }),
      );
    const unblock = () => {
      childMayFinish.resolve();
      effectMayFinish.resolve();
    };
    signal.addEventListener("abort", unblock, { once: true });
    let pluginError: unknown;
    let parentError: unknown;
    let originalClosed = false;
    const builder = createTestPluginRegistry();
    const artifact = {
      source: path.join(root, "index.js"),
      rootDir: root,
      origin: "bundled" as const,
      preferBuiltPluginArtifacts: false,
    };
    const record = createPluginRecord({
      id: "owner-proof",
      ...artifact,
      contracts: { tools: ["owner_proof"] },
    });
    bindPluginRuntimeArtifactSelection(record, {
      preferBuiltPluginArtifacts: false,
      runtimeEntry: resolvePluginRuntimeArtifactSelection({ ...artifact, entryKind: "runtime" }),
    });
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: record.id, ...artifact, enabledByDefault: true, contracts: record.contracts },
      ],
    });
    const pluginConfig = {
      ...config,
      plugins: { enabled: true, entries: { "owner-proof": { enabled: true } } },
    };
    setPluginRuntimeLoadContext(builder.registry, {
      rawConfig: pluginConfig,
      config: pluginConfig,
      activationSourceConfig: pluginConfig,
      autoEnabledReasons: {},
      workspaceDir: root,
      env: process.env,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      manifestRegistry: metadataSnapshot.manifestRegistry,
      metadataSnapshot,
    });
    builder.registry.plugins.push(record);
    builder.createApi(record, { config: {}, registrationMode: "full" }).registerTool(
      {
        contextVersion: 2,
        create: (context) => ({
          name: "owner_proof",
          label: "Owner proof",
          description: "Synthetic owner-only file write",
          parameters: { type: "object", properties: {} },
          async execute() {
            if (!context.senderIsOwner) {
              throw new Error("owner_authority_required");
            }
            expect(context.requesterSenderId).toBe("owner-proof");
            pluginEntered.resolve();
            await effectMayFinish.promise;
            context.assertInvocationCurrent();
            fs.writeFileSync(effectPath, "authorized effect");
            return { content: [{ type: "text", text: "written" }], details: {} };
          },
        }),
      },
      { name: "owner_proof" },
    );
    agentCommandMock.mockImplementation(async (input) => {
      const opts = input as AgentCommandGatewayIngressOpts;
      const runId = expectDefined(opts.runId, "Gateway run ID");
      // The simulated command replaces session-preparation, which publishes these run facts.
      registerAgentRunContext(runId, {
        agentId: "main",
        sessionKey: opts.sessionKey,
        sessionId: opts.sessionKey === child ? "owner-proof-child" : parentId,
      });
      await opts.userTurnTranscriptRecorder?.persistApproved();
      let text = "child result";
      if (opts.sessionKey === child) {
        await childMayFinish.promise;
        if (outcome === "child error") {
          throw new Error("synthetic child failure");
        }
      } else {
        const admission = prepareAgentCommandExecutionIdentity({
          opts,
          prepared: {
            cfg: getRuntimeConfig(),
            runId,
            sessionAgentId: "main",
            sessionId: parentId,
            sessionKey: parent,
          },
          ingress: { kind: "gateway-client", boundary: "agent", state: "present" },
          lifecycleGeneration: expectDefined(opts.lifecycleGeneration, "Gateway generation"),
        });
        try {
          expect(originalClosed).toBe(true);
          expect(opts.inputProvenance).toMatchObject({
            kind: "inter_session",
            sourceTool: "subagent_announce",
            sourceSessionKey: child,
          });
          const admitted = await admission.admit("embedded");
          const caller = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: admitted,
            agentId: "main",
            sessionKey: parent,
          });
          await withGatewayToolCallerIdentity(caller, () =>
            withPluginRuntimeRegistryScope(builder.registry, async () => {
              const tool = expectDefined(
                resolveOpenClawPluginToolsForOptions({
                  options: {
                    runId,
                    agentSessionKey: parent,
                    sessionId: parentId,
                    workspaceDir: root,
                    senderIsOwner: false,
                    pluginToolAllowlist: ["owner_proof"],
                  },
                }).find((entry) => entry.name === "owner_proof"),
                "registered plugin tool",
              );
              try {
                await tool.execute("owner-effect", {});
              } catch (error) {
                pluginError = error;
              }
            }),
          );
        } catch (error) {
          parentError = error;
        } finally {
          await admission.finish();
          parentFinished.resolve();
        }
        text = "parent complete";
      }
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt: 1,
          endedAt: Date.now(),
          terminalReply: buildAgentRunTerminalReplySnapshot({ visibleText: text, rawText: text }),
        },
      });
      return {
        payloads: [{ text, mediaUrl: null }],
        meta: {
          durationMs: 1,
          terminalReply: buildAgentRunTerminalReplySnapshot({ visibleText: text, rawText: text }),
        },
      };
    });
    const { operationalRunInstance } = createTestAdmittedRunContext(originalRun);
    const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
    registerAgentRunContext(originalRun, {
      agentId: "main",
      sessionKey: parent,
      sessionId: parentId,
    });
    try {
      try {
        const capability = expectDefined(
          createCronCreatorAuthorityCapability(
            originalRun,
            { kind: "unknown" },
            { source: "channel-owner", isCurrent: owner.isCurrent },
            () => true,
            undefined,
            owner,
          ),
          "original owner capability",
        );
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const sent = withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: parent,
            operationalRunInstance,
            approvalAuthority: authority,
            receiptAuthority: () => validateAgentRunDelegatedAuthority(authority),
            gatewayContextResolver: () => kernel.gatewayRequestContext,
          },
          () =>
            runWithCronCreatorAuthorityCapability(capability, async () => {
              const send = expectDefined(
                createOpenClawTools({
                  runId: originalRun,
                  agentSessionKey: parent,
                  sessionId: parentId,
                  config: { ...config, tools: { sessions: { visibility: "all" } } },
                }).find((tool) => tool.name === "sessions_send"),
                "sessions_send tool",
              );
              const result = await send.execute("send-followup", {
                sessionKey: child,
                message: "finish authorized work",
                timeoutSeconds: 1,
              });
              expect(result.details).toMatchObject({ status: "accepted" });
            }),
        );
        await withinTest(
          awaitGateBeforeSettlement(
            inlineWaitStarted.promise,
            sent,
            "Send ended before entering its inline completion wait",
          ),
          signal,
        );
        await vi.advanceTimersByTimeAsync(1_000);
        await withinTest(sent, signal);
      } finally {
        releaseAgentRunDelegatedAuthority(authority);
        clearAgentRunContext(originalRun);
        originalClosed = true;
        childMayFinish.resolve();
      }
      await withinTest(
        awaitGateBeforeSettlement(
          requesterAccepted.promise,
          completionClosed.promise,
          "Completion ended before private requester admission",
        ),
        signal,
      );
      // Cross the native accepted-ack yield without advancing run deadlines.
      await vi.advanceTimersByTimeAsync(10);
      await withinTest(
        awaitGateBeforeSettlement(
          pluginEntered.promise,
          parentFinished.promise,
          "Requester ended before its plugin could check owner authority",
        ),
        signal,
      );
      expect(parentError).toBeUndefined();
      expect(pluginError).toBeUndefined();
      if (outcome === "owner revoked") {
        setRuntimeConfigSnapshot({
          ...config,
          commands: { ownerAllowFrom: [] },
        });
      } else if (outcome === "new user turn") {
        revokeRequesterCronAuthority(parent);
      }
      effectMayFinish.resolve();
      await withinTest(parentFinished.promise, signal);
      await withinTest(completionClosed.promise, signal);
      expect(parentError).toBeUndefined();
      expect(requesterReceipt).toMatchObject({
        status: "ok",
        inputProcessingCompleted: true,
      });
      if (outcome === "success" || outcome === "child error") {
        expect(pluginError).toBeUndefined();
        expect(fs.readFileSync(effectPath, "utf8")).toBe("authorized effect");
      } else {
        expect(pluginError).toBeInstanceOf(Error);
        expect(String(pluginError)).toMatch(/owner identity is no longer active/);
        expect(fs.existsSync(effectPath)).toBe(false);
      }
    } finally {
      unblock();
      closeCompletion?.();
      observeInlineWait.mockRestore();
      observeRequesterAdmission.mockRestore();
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(10);
      }
      vi.useRealTimers();
      revokeRequesterCronAuthority(parent);
      await waitForGatewayActiveWork(10_000);
      signal.removeEventListener("abort", unblock);
      await disposePluginRegistryInstances(builder.registry);
    }
  },
);
