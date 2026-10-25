import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END } from "@openclaw/ai/internal/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_TURN_ADMISSION_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-turn-admission.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import { makeAgentUserMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import type { PluginHookBeforeAgentRunEvent } from "../../plugins/hook-types.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { prepareSkillBundle } from "../../skills/library/bundle.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { runWorkerEmbeddedTurn } from "../../worker/embedded-agent.runtime.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerInferenceStore } from "./inference-store.js";
import { createWorkerInferenceManager } from "./inference.js";
import { DONE } from "./inference.test-support.js";
import { writePlacementEnvironmentFixture } from "./placement-test-fixtures.js";
import { admitWorkerTurnInput, getWorkerTurnToolSurface } from "./placement-turn-claim-events.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import {
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  credential,
  database,
  openSessionManager,
  placements,
  readWorkerTurnTranscriptStorageRows,
  reconcileUnchangedLocalWorkspace,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerTurnRpc } from "./worker-turn-rpc.js";

afterAll(closeStateDatabaseForTest);

describe("worker-side before_agent_run admission", () => {
  beforeEach(async () => {
    await setupWorkerTurnLauncherTest();
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
  });
  afterEach(() => cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));
  afterEach(resetGlobalHookRunner);
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    { modern: true, block: false, recorderOwned: false, forged: false },
    { modern: true, block: false, recorderOwned: true, forged: false },
    { modern: true, block: true, recorderOwned: false, forged: false },
    { modern: true, block: true, recorderOwned: true, forged: false },
    { modern: false, block: true, recorderOwned: false, forged: false },
    { modern: false, block: false, recorderOwned: false, forged: false },
    { modern: true, block: false, recorderOwned: false, forged: true },
  ])(
    "gates the final worker prompt before inference and persistence (%j)",
    async ({ modern, block, recorderOwned, forged }) => {
      await seedActivePlacement();
      const input = turn(`admission-${modern}-${block}-${recorderOwned}`);
      const retainedHistory = forged
        ? [makeAgentUserMessage({ content: "Gateway-retained policy context", timestamp: 1 })]
        : [];
      for (const message of retainedHistory) {
        await (await openSessionManager()).appendMessageAsync(message);
      }
      const recorder = recorderOwned
        ? createUserTurnTranscriptRecorder({
            target: () => ({ ...sessionTarget, sessionEntry: undefined }),
            input: { text: input.prompt },
          })
        : undefined;
      let messagesAtGate: unknown[] | undefined;
      const handler = vi.fn(async (event: PluginHookBeforeAgentRunEvent) => {
        // Both Gateway persistence owners must wait for the policy decision.
        messagesAtGate = (await openSessionManager()).buildSessionContext().messages;
        return block || (modern && !event.systemPrompt?.includes("stable prefix"))
          ? { outcome: "block" as const, reason: "Synthetic policy", message: "Request blocked." }
          : { outcome: "pass" as const };
      });
      await using runtime = await acquireAgentRunPreparedModelRuntime({
        config: input.config,
        agentId: input.agentId,
        agentDir: resolveAgentDir(input.config, input.agentId),
        workspaceDir: input.workspaceDir,
      });
      const registry = runtime.snapshot.pluginRegistry;
      assert(registry);
      const registration = {
        pluginId: "admission-policy",
        hookName: "before_agent_run" as const,
        handler,
        source: "test",
      };
      registry.typedHooks.push(registration);
      initializeGlobalHookRunner(registry);
      const environment = attachedEnvironment();
      const bootstrapReceipt = environment.bootstrapReceipt;
      assert(bootstrapReceipt);
      if (modern) {
        bootstrapReceipt.protocolFeatures.push(WORKER_TURN_ADMISSION_PROTOCOL_FEATURE);
      }
      const observedModel = new Error("Synthetic model boundary reached");
      let promptForWorker: string | undefined;
      const stream = vi.fn<Parameters<typeof runWorkerEmbeddedTurn>[0]["inference"]["stream"]>(
        ({ context }) => {
          const event = handler.mock.calls[0]?.[0];
          if (modern) {
            expect(event?.systemPrompt).toBe(context.systemPrompt);
          } else {
            expect(event).not.toHaveProperty("systemPrompt");
          }
          expect(context.systemPrompt).toContain("stable prefix\nRuntime: agent=main | host=");
          expect(context.systemPrompt).toContain("skill-resources-");
          expect(context.systemPrompt).not.toContain("/gateway/skills/stable/SKILL.md");
          throw observedModel;
        },
      );
      const launch = vi.fn<NonNullable<ReturnType<typeof createWorkerTurnTunnel>["launchTurn"]>>(
        async ({ plan, turnClaim, onDispatchReady, assertCurrent }) => {
          onDispatchReady?.();
          assert(typeof plan.assignment.prompt === "string");
          promptForWorker = plan.assignment.prompt;
          const identity = {
            environmentId: environment.environmentId,
            ownerEpoch: environment.ownerEpoch,
            sessionId: turnClaim.sessionId,
            runId: turnClaim.runId,
            turnClaim,
            credentialHash: credential().deliveryId,
            bundleHash: bootstrapReceipt.bundleHash,
            rpcSetVersion: 1,
            protocolFeatures: bootstrapReceipt.protocolFeatures,
            credentialExpiresAtMs: Date.now() + 60_000,
          };
          const toolRuntime = getWorkerTurnToolSurface(identity);
          assert(toolRuntime);
          const files = [
            { path: "SKILL.md", content: "# Stable worker skill\n", encoding: "utf8" as const },
          ];
          await runWorkerEmbeddedTurn({
            ...plan.assignment,
            github: undefined,
            computer: undefined,
            systemPrompt:
              `stable prefix\nRuntime: agent=main${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}\n` +
              "<available_skills>\n<skill>\n<name>stable</name>\n" +
              "<location>/gateway/skills/stable/SKILL.md</location>\n</skill>\n</available_skills>",
            skillResources: {
              version: 1,
              skills: [
                {
                  name: "stable",
                  description: "Worker admission fixture",
                  sourcePath: "/gateway/skills/stable/SKILL.md",
                  revision: prepareSkillBundle(files).revision,
                  files,
                },
              ],
            },
            cwd: root,
            workerContainmentRoot: root,
            stateDir: path.join(root, "worker-state"),
            sessionId: turnClaim.sessionId,
            sessionKey: sessionTarget.sessionKey,
            inference: { stream },
            transcript: { commit: async () => {} },
            live: { enqueuePreview: () => true, emitTerminal: async () => {} },
            gatewayTools: {
              invokeGatewayTool: async () => {
                throw new Error("Unexpected tool call");
              },
              cancelGatewayTool: async () => {
                throw new Error("Unexpected tool cancellation");
              },
            },
            toolSurface: await toolRuntime.getSurface(identity),
            allowedToolNames: plan.assignment.toolAuthority.allowedToolNames,
            execAuthority: plan.assignment.toolAuthority.exec,
            admitTurn: modern
              ? async (event) => {
                  assertCurrent?.();
                  const admission = await admitWorkerTurnInput(
                    identity,
                    {
                      ...event,
                      ...(forged
                        ? {
                            prompt: "Worker-forged harmless prompt",
                            messages: [
                              { role: "user" as const, content: "Forged history", timestamp: 2 },
                            ],
                          }
                        : {}),
                      runEpoch: environment.ownerEpoch,
                    },
                    () => true,
                  );
                  assert(admission.ok);
                  const { result } = admission;
                  if (result.outcome === "allow") {
                    expect(result.baseLeafId).toBe((await openSessionManager()).getLeafId());
                    expect(result.baseLeafId).not.toBeNull();
                  }
                  return result.outcome === "allow";
                }
              : undefined,
          });
          return createCommandResult();
        },
      );
      const tunnel = createWorkerTurnTunnel({
        launchTurn: launch,
        reconcileWorkspace: reconcileUnchangedLocalWorkspace,
      });
      const environments = {
        ...unusedEnvironments(),
        get: () => environment,
        acquireTurnCredential: async () => credential(),
        startTunnel: async () => tunnel,
        acknowledgeCredentialDelivery: async () => true,
      };
      const provider = createWorkerSessionTurnPlacementProvider({ placements, environments });
      try {
        const execution = provider.executeTurn(
          { ...sessionTarget, runId: input.runId },
          {
            ...input,
            pluginGeneration: runtime.pluginGeneration,
            userTurnTranscriptRecorder: recorder,
          },
          vi.fn(),
        );
        if (block) {
          const result = await execution;
          expect(result.meta.error?.kind).toBe("hook_block");
          expect(result.meta.livenessState).toBe("blocked");
          expect(stream).not.toHaveBeenCalled();
          const messages = (await openSessionManager()).buildSessionContext().messages;
          expect(messages).toEqual([
            expect.objectContaining({
              role: "user",
              content: [{ type: "text", text: result.payloads?.[0]?.text }],
              idempotencyKey: `hook-block:before_agent_run:user:${input.runId}`,
            }),
          ]);
          expect(JSON.stringify(readWorkerTurnTranscriptStorageRows())).not.toContain(input.prompt);
        } else {
          await expect(execution).rejects.toThrow(observedModel.message);
          expect(stream).toHaveBeenCalledOnce();
          expect((await openSessionManager()).buildSessionContext().messages).toEqual([
            ...retainedHistory,
            expect.objectContaining({
              role: "user",
              content: recorderOwned ? input.prompt : [{ type: "text", text: input.prompt }],
            }),
          ]);
        }
        expect(handler).toHaveBeenCalledOnce();
        expect(messagesAtGate).toEqual(retainedHistory);
        expect(handler.mock.calls[0]?.[0]).toMatchObject({
          prompt: modern ? promptForWorker : input.prompt,
          messages: forged
            ? [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: expect.stringContaining("Gateway-retained policy context"),
                    },
                  ],
                  timestamp: 1,
                },
              ]
            : [],
          channelId: "telegram",
          accountId: "worker-account",
        });
        if (modern) {
          expect(launch).toHaveBeenCalledOnce();
          expect(handler.mock.calls[0]?.[0].systemPrompt).toContain("stable prefix");
        } else {
          expect(launch).toHaveBeenCalledTimes(block ? 0 : 1);
          expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("systemPrompt");
        }
      } finally {
        registry.typedHooks.splice(registry.typedHooks.indexOf(registration), 1);
        input.preparedRunAdmission.close();
      }
    },
  );

  it.each([
    {
      result: { stdout: "", stderr: "Worker startup failed", code: 1 },
      error: "Cloud worker process failed before completing the turn: Worker startup failed",
    },
    {
      result: {
        stdout: JSON.stringify({
          status: "not-started",
          reason: "admission-deadline",
          errorText: "worker admission deadline exceeded: connect failed",
        }),
        stderr: "",
        code: 0,
      },
      error: "worker admission deadline exceeded: connect failed",
    },
  ])("preserves a launch failure before input admission ($error)", async ({ result, error }) => {
    const environment = attachedEnvironment();
    const bootstrapReceipt = environment.bootstrapReceipt;
    assert(bootstrapReceipt);
    bootstrapReceipt.protocolFeatures.push(WORKER_TURN_ADMISSION_PROTOCOL_FEATURE);
    await seedActivePlacement();
    const input = turn("worker-startup-failed");
    const launch = vi.fn<NonNullable<ReturnType<typeof createWorkerTurnTunnel>["launchTurn"]>>(
      async ({ onDispatchReady }) => {
        onDispatchReady?.();
        return { ...result, signal: null, killed: false, termination: "exit" };
      },
    );
    const tunnel = createWorkerTurnTunnel({
      launchTurn: launch,
      reconcileWorkspace: reconcileUnchangedLocalWorkspace,
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      placements,
      environments: {
        ...unusedEnvironments(),
        get: () => environment,
        acquireTurnCredential: async () => credential(),
        startTunnel: async () => tunnel,
        acknowledgeCredentialDelivery: async () => true,
      },
    });
    try {
      await expect(
        provider.executeTurn({ ...sessionTarget, runId: input.runId }, input, vi.fn()),
      ).rejects.toThrow(error);
      expect(readWorkerTurnTranscriptStorageRows()).toEqual([]);
    } finally {
      input.preparedRunAdmission.close();
    }
  });

  it("rejects worker effects and successful launch results before admission", async () => {
    const environment = attachedEnvironment();
    const bootstrapReceipt = environment.bootstrapReceipt;
    assert(bootstrapReceipt);
    bootstrapReceipt.protocolFeatures.push(WORKER_TURN_ADMISSION_PROTOCOL_FEATURE);
    writePlacementEnvironmentFixture(database, environment);
    await seedActivePlacement();
    const input = turn("worker-skipped-admission");
    const store = await createWorkerEnvironmentStore({ database });
    const execute = vi.fn(async () => DONE);
    const inference = createWorkerInferenceManager({
      execute,
      store: createWorkerInferenceStore({ path: database.path }),
    });
    const committer = createWorkerTranscriptCommitter({ getConfig: () => input.config });
    const applyLiveEvent = vi.fn<
      NonNullable<Parameters<typeof createWorkerTurnRpc>[0]["liveEvents"]>["apply"]
    >(async ({ request }) => ({ ok: true, result: { ackedSeq: request.seq } }));
    const rpc = createWorkerTurnRpc({
      store,
      placementStore: createWorkerSessionPlacementGate(placements),
      applyTranscriptCommit: committer.commit,
      liveEvents: { apply: applyLiveEvent },
      inference,
      prepareInstallation: async () => {
        throw new Error("Unexpected installation");
      },
      isStopping: () => false,
      now: Date.now,
      withLock: async (_key, task) => await task(),
    });
    const admissionError =
      "Worker turn input admission is required before persistence or inference";
    const launch = vi.fn<NonNullable<ReturnType<typeof createWorkerTurnTunnel>["launchTurn"]>>(
      async ({ plan, turnClaim, onDispatchReady }) => {
        onDispatchReady?.();
        const grant = credential();
        const credentialHash = hashWorkerCredential(grant.credential, turnClaim);
        await store.renewCredential({
          environmentId: environment.environmentId,
          expectedOwnerEpoch: environment.ownerEpoch,
          sessionId: turnClaim.sessionId,
          rpcSetVersion: grant.rpcSetVersion,
          expiresAtMs: grant.expiresAtMs,
          credentialHash,
        });
        const identity = {
          environmentId: environment.environmentId,
          ownerEpoch: environment.ownerEpoch,
          sessionId: turnClaim.sessionId,
          runId: turnClaim.runId,
          turnClaim,
          credentialHash,
          bundleHash: bootstrapReceipt.bundleHash,
          rpcSetVersion: grant.rpcSetVersion,
          protocolFeatures: bootstrapReceipt.protocolFeatures,
          credentialExpiresAtMs: grant.expiresAtMs,
        };
        expect(rpc.validateWorkerConnection(identity)).toBeNull();
        const toolRuntime = getWorkerTurnToolSurface(identity);
        assert(toolRuntime);
        const surface = await toolRuntime.getSurface(identity);
        const tool = surface.tools[0];
        assert(tool);
        using invoke = vi.spyOn(toolRuntime, "invoke");
        await expect(
          rpc.invokeGatewayTool(
            identity,
            {
              generation: surface.generation,
              toolCallId: "skipped-tool-call",
              toolId: tool.id,
              arguments: {},
            },
            { send: vi.fn() },
          ),
        ).rejects.toThrow(admissionError);
        expect(invoke).not.toHaveBeenCalled();
        await expect(
          rpc.pushLiveEvent(identity, {
            runEpoch: identity.ownerEpoch,
            runId: identity.runId,
            seq: 1,
            lastAckedSeq: 0,
            event: {
              kind: "tool",
              payload: {
                phase: "start",
                name: "read",
                toolCallId: "skipped-tool-call",
                args: { private: "Unapproved input" },
              },
            },
          }),
        ).rejects.toThrow(admissionError);
        expect(applyLiveEvent).not.toHaveBeenCalled();
        await expect(
          rpc.startInference(
            identity,
            {
              runEpoch: identity.ownerEpoch,
              sessionId: identity.sessionId,
              runId: identity.runId,
              turnId: plan.assignment.turnId,
              modelRef: plan.assignment.modelRef,
              context: { messages: [] },
              options: {},
            },
            { connectionId: "skipped-admission", send: vi.fn() },
          ),
        ).rejects.toThrow(admissionError);
        await expect(
          rpc.commitTranscript(identity, {
            runEpoch: identity.ownerEpoch,
            seq: 1,
            baseLeafId: null,
            messages: [
              { role: "user", content: [{ type: "text", text: "Bypassed input" }], timestamp: 1 },
            ],
          }),
        ).rejects.toThrow(admissionError);
        expect(execute).not.toHaveBeenCalled();
        expect((await openSessionManager()).buildSessionContext().messages).toEqual([]);
        await expect(
          rpc.pushLiveEvent(identity, {
            runEpoch: identity.ownerEpoch,
            runId: identity.runId,
            seq: 1,
            lastAckedSeq: 0,
            event: {
              kind: "lifecycle",
              payload: {
                phase: "finishing",
                endedAt: 1,
                error: "Unapproved input",
                toolErrorSummary: "Private worker detail",
              },
            },
          }),
        ).resolves.toMatchObject({ ok: true });
        expect(applyLiveEvent).toHaveBeenCalledOnce();
        expect(applyLiveEvent.mock.calls[0]?.[0].request.event).toEqual({
          kind: "lifecycle",
          payload: { phase: "finishing", endedAt: 1, aborted: true },
        });
        // A valid successful result must not let finalization persist unapproved input.
        return createCommandResult({
          stdout: JSON.stringify({
            status: "completed",
            transcriptLeafId: null,
            transcriptNextSeq: 1,
          }),
        });
      },
    );
    const tunnel = createWorkerTurnTunnel({
      launchTurn: launch,
      reconcileWorkspace: reconcileUnchangedLocalWorkspace,
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      placements,
      // The scrubbed terminal ACK hands recovery back to this external lifecycle owner.
      reconcileActivePlacement: async () => {},
      environments: {
        ...unusedEnvironments(),
        get: () => environment,
        acquireTurnCredential: async () => credential(),
        startTunnel: async () => tunnel,
        acknowledgeCredentialDelivery: async () => true,
      },
    });
    try {
      await expect(
        provider.executeTurn({ ...sessionTarget, runId: input.runId }, input, vi.fn()),
      ).rejects.toThrow(admissionError);
      expect(launch).toHaveBeenCalledOnce();
      expect(execute).not.toHaveBeenCalled();
      expect(readWorkerTurnTranscriptStorageRows()).toEqual([]);
    } finally {
      await inference.stop();
      rpc.clear();
      input.preparedRunAdmission.close();
    }
  });
});
