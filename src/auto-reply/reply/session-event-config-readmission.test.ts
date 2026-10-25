import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  readAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { completionConfig } from "../../agents/bash-tools.lifecycle.test-support.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { FailoverError } from "../../agents/failover-error.js";
import { createAgentHarnessHostCapabilities } from "../../agents/harness/host-capability.js";
import { createMessageTool } from "../../agents/tools/message-tool-execution.js";
import { resolveAttemptWorkspaceSandbox } from "../../agents/workspace-sandbox.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/outbound.types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-writable.js";
import { makeCronJob } from "../../cron/delivery.test-helpers.js";
import { captureCronInferenceBinding } from "../../cron/inference-binding.runtime.js";
import { TEST_SCHEDULED_TURN } from "../../cron/scheduled-occurrence.test-support.js";
import { runCronSessionTurn } from "../../cron/session-run.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import * as routedReplies from "./route-reply.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";
import { createEventManagedTools } from "./session-event.test-support.js";
// mock-isolation: Synthetic model decisions; admission, queue and real tool writes stay real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: vi.fn(),
}));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
// Match Gateway startup: activate the real reply runtimes before timing turn authority.
await Promise.all([
  import("../dispatch.js"),
  import("./get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

async function startRun(params: RunEmbeddedAgentParams) {
  const admitted = expectDefined(
    await params.preparedRunAdmission?.admit("gateway", params.runId),
    "reply admission",
  );
  params.onExecutionPhase?.({ phase: "model_call_started" });
  await params.onExecutionStarted?.();
  await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
  return admitted;
}

/** Uses the real managed write tool; the model decision alone is mocked. */
async function attemptRealWrite(
  params: RunEmbeddedAgentParams,
  filePath: string,
  operatorAuthority?: AdmittedRunOperatorAuthority,
) {
  const admittedRunContext = await startRun(params);
  if (operatorAuthority) {
    expect(readAdmittedRunOperatorAuthority(admittedRunContext)?.profileId).toBe("original-guest");
  }
  const workspace = await resolveAttemptWorkspaceSandbox({ ...params, admittedRunContext });
  const host = createAgentHarnessHostCapabilities({
    attempt: {
      admittedRunContext,
      runId: params.runId,
      abortSignal: params.abortSignal,
      config: params.config,
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionTarget: params.sessionTarget,
      permissionMode: params.permissionMode,
      requireWorkspaceOnly: params.requireWorkspaceOnly,
      sessionRoot: workspace.sessionPermissionRoot,
      workspaceDir: params.workspaceDir,
      cwd: params.cwd,
      toolExecutionAllow: params.toolExecutionAllow,
      toolsAllow: params.toolsAllow,
      trigger: params.trigger,
      senderIsOwner: params.senderIsOwner,
    },
    pluginId: "openclaw",
  });
  try {
    const tools = createEventManagedTools(
      params,
      workspace,
      expectDefined(host.capabilities.createToolSurface, "managed tool surface"),
    );
    const write = tools.find((tool) => tool.name === "write");
    if (write) {
      await write
        .execute("readmission-write", { path: filePath, content: "written\n" })
        .catch(() => undefined);
    }
  } finally {
    host.close();
  }
}

it.for([
  "published-deny",
  "retained-ceiling",
  "allow-control",
  "revoked-producer",
  "publication-storm",
  "scheduled-control",
  "scheduled-revoked",
  "scheduled-model-revoked",
  "scheduled-model-malformed",
  "scheduled-subagent-default",
  "scheduled-subagent-locked",
  "scheduled-gmail-default",
  "scheduled-account-cross-provider",
  "scheduled-account-same-provider",
  "scheduled-account-bound-unavailable",
] as const)(
  "re-admits accepted deferred work after a config publication: %s",
  async (scenario, { signal }) => {
    await withOpenClawTestState(
      { label: "session-event-config-readmission", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const config = completionConfig(state.workspaceDir);
        const scheduledAccount = scenario.startsWith("scheduled-account-");
        const boundAccount = scenario === "scheduled-account-bound-unavailable";
        const scheduledProvider =
          scenario === "scheduled-account-cross-provider" ? "mock-other" : "mock-openai";
        const explicitScheduledModel =
          scenario === "scheduled-control" ||
          scenario.startsWith("scheduled-model-") ||
          scheduledAccount;
        const scheduledSubagent = scenario.startsWith("scheduled-subagent-");
        if (explicitScheduledModel || scheduledSubagent || scenario === "scheduled-gmail-default") {
          config.agents = {
            ...config.agents,
            defaults: {
              ...config.agents?.defaults,
              modelPolicy: {
                allow: [
                  "mock-openai/*",
                  ...(scheduledProvider === "mock-other" ? ["mock-other/*"] : []),
                ],
              },
              ...(scheduledSubagent ? { subagents: { model: "mock-openai/gpt-5.6-luna" } } : {}),
              models: {
                ...config.agents?.defaults?.models,
                "mock-openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
                ...(scheduledProvider === "mock-other"
                  ? { [`${scheduledProvider}/gpt-5.6-sol`]: { agentRuntime: { id: "openclaw" } } }
                  : {}),
              },
            },
          };
        }
        if (scenario === "scheduled-gmail-default") {
          config.hooks = { gmail: { model: "mock-openai/gpt-5.6-luna", thinking: "off" } };
        }
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        if (scheduledAccount) {
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "mock-openai:conversation": {
                type: "api_key",
                provider: "mock-openai",
                key: "synthetic-conversation-key",
              },
              "mock-other:automation": {
                type: "api_key",
                provider: "mock-other",
                key: "synthetic-automation-key",
              },
            },
          });
        }
        const inferenceBinding = boundAccount
          ? expectDefined(
              await captureCronInferenceBinding({
                cfg: config,
                agentId: "main",
                model: "mock-openai/gpt-5.6-sol@mock-openai:conversation",
              }),
              "scheduled inference binding",
            )
          : undefined;
        const missingDestinationProfileId = boundAccount
          ? `personal:${ensureProfileForEmail("destination@example.test").id}:${randomUUID()}`
          : undefined;
        const scope = { agentId: "main", sessionKey: "agent:main:config-readmission" };
        await replaceSessionEntry(scope, {
          sessionId: "config-readmission",
          lifecycleRevision: "original",
          permissionMode: "full",
          ...(scheduledAccount
            ? {
                authProfileOverride: "mock-openai:conversation",
                authProfileOverrideSource: "user" as const,
                authProfileOverrideCompactionCount: 2,
              }
            : {}),
          ...(scenario === "scheduled-subagent-locked" || boundAccount
            ? { modelSelectionLocked: true }
            : {}),
          ...(scenario === "scheduled-gmail-default"
            ? {
                providerOverride: "mock-openai",
                modelOverride: "gpt-5.6-luna",
                thinkingLevel: "off",
              }
            : {}),
          // A channel route arms durable restart-recovery source claims.
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: "-100001", accountId: "readmission" },
          }),
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        });
        let sourceReferences = 1;
        const operatorAuthority =
          scenario === "allow-control" || scenario.startsWith("scheduled-")
            ? createAdmittedRunOperatorAuthority({
                profileId: "original-guest",
                scopes: ["operator.write"],
                assertCurrent() {
                  if (sourceReferences === 0) {
                    throw new Error("original source released");
                  }
                },
                retain() {
                  sourceReferences++;
                  return () => {
                    sourceReferences--;
                  };
                },
              })
            : undefined;
        const filePath = path.join(state.workspaceDir, "readmission.txt");
        const firstStarted = createDeferred();
        const releaseFirst = createDeferred();
        const prompts: string[] = [];
        const laneStates: boolean[] = [];
        runEmbeddedAgentMock
          .mockReset()
          .mockImplementation(async (params: RunEmbeddedAgentParams) => {
            prompts.push(params.prompt);
            if (prompts.length === 1) {
              await startRun(params);
              firstStarted.resolve();
              await releaseFirst.promise;
            } else if (scheduledSubagent && prompts.length === 2) {
              if (scenario === "scheduled-subagent-locked") {
                await startRun(params);
              }
              throw new FailoverError("Synthetic scheduled primary unavailable", {
                reason: "model_not_found",
                provider: params.provider,
                model: params.model,
              });
            } else {
              if (scenario === "scheduled-control") {
                expect(laneStates.at(-1)).toBe(false);
              }
              if (boundAccount) {
                expect((await readSessionEntryInWorker(scope))?.authProfileOverride).toBe(
                  missingDestinationProfileId,
                );
                const binding = expectDefined(params.authProfileBinding, "live scheduled account");
                expect(binding.profileId).toBe("mock-openai:conversation");
                await binding.revalidate();
                binding.assertCurrent();
                expect(params.allowAuthProfileFallback).toBe(false);
              }
              await attemptRealWrite(params, filePath, operatorAuthority);
            }
            return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
          });
        const target = await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey, {
          operatorAuthority,
        });
        const first = enqueueSessionEventForHost("First admitted work", {
          ...scope,
          source: "task",
          expectedTarget: target,
          abortSignal: signal,
          deliver: false,
        });
        let publications = 0;
        let storming = false;
        let revoked = false;
        let completion: ReturnType<typeof enqueueSessionEventForHost> | undefined;
        let replay: ReturnType<typeof enqueueSessionEventForHost> | undefined;
        try {
          await expect(first.accepted).resolves.toEqual({ ok: true });
          await withinTest(firstStarted.promise, signal);
          if (scheduledAccount) {
            expect(runEmbeddedAgentMock.mock.calls[0]?.[0].authProfileId).toBe(
              "mock-openai:conversation",
            );
          }
          if (boundAccount) {
            await patchSessionEntryCore(scope, () => ({
              authProfileOverride: missingDestinationProfileId,
            }));
            expect((await readSessionEntryInWorker(scope))?.authProfileOverride).toBe(
              missingDestinationProfileId,
            );
          }
          completion = enqueueSessionEventForHost("Background exec completed", {
            ...scope,
            source: "exec",
            // The real exec producer's durable source identity.
            sourceTurnId: "exec:readmission-process",
            // The producing turn's tool ceiling travels with the captured target.
            expectedTarget:
              scenario === "retained-ceiling" ? { ...target, toolsAllow: ["read"] } : target,
            abortSignal: signal,
            ...(scenario.startsWith("scheduled-")
              ? {
                  scheduledAutomation: {
                    ...TEST_SCHEDULED_TURN,
                    job: {
                      id: "scheduled-readmission",
                      name: "Scheduled readmission",
                      enabled: true,
                      createdAtMs: 1,
                      updatedAtMs: 1,
                      schedule: { kind: "every" as const, everyMs: 60_000 },
                      sessionTarget: `session:${scope.sessionKey}` as const,
                      wakeMode: "now" as const,
                      payload: {
                        kind: "agentTurn" as const,
                        message: "Background exec completed",
                        ...(scenario === "scheduled-gmail-default"
                          ? { externalContentSource: "gmail" as const }
                          : {}),
                        ...(scenario === "scheduled-subagent-locked"
                          ? { fallbacks: ["mock-openai/gpt-5.6-sol"] }
                          : {}),
                        ...(explicitScheduledModel
                          ? {
                              model:
                                scenario === "scheduled-model-malformed"
                                  ? "openai/"
                                  : `${scheduledProvider}/gpt-5.6-sol`,
                            }
                          : {}),
                      },
                      state: {},
                      inferenceBinding,
                    },
                    onLaneWait: ({ waiting }) => laneStates.push(waiting),
                    operatorAuthority,
                    assertCurrent: () => {
                      if (revoked) {
                        throw new Error("Scheduled source retired");
                      }
                    },
                  },
                }
              : {}),
            assertCurrent: () => {
              if (revoked && !scenario.startsWith("scheduled-")) {
                throw new Error("Background producer retired");
              }
              if (storming) {
                // Identical values are a no-op publication; each storm step changes policy.
                setRuntimeConfigSnapshot({
                  ...config,
                  tools: { deny: ["write", `storm-${++publications}`] },
                });
              }
            },
          });
          sourceReferences--;
          // Invalid explicit models fail before even becoming a deferred follow-up.
          if (scenario === "scheduled-model-malformed") {
            await expect(completion.accepted).resolves.toMatchObject({ ok: false });
          } else {
            await expect(completion.accepted).resolves.toEqual({ ok: true });
          }
          if (scenario === "scheduled-control") {
            expect(laneStates.at(-1)).toBe(true);
          }
          setRuntimeConfigSnapshot({
            ...config,
            ...(scenario === "scheduled-gmail-default"
              ? {
                  hooks: { gmail: { model: "mock-openai/gpt-5.6-sol", thinking: "high" as const } },
                }
              : {}),
            ...(scenario === "scheduled-model-revoked" || scheduledSubagent
              ? {
                  agents: {
                    ...config.agents,
                    defaults: {
                      ...config.agents?.defaults,
                      ...(scenario === "scheduled-model-revoked"
                        ? { modelPolicy: { allow: ["mock-openai/gpt-5.6-luna"] } }
                        : {
                            subagents: {
                              model: {
                                primary: "mock-openai/gpt-5.6-sol",
                                fallbacks: ["mock-openai/gpt-5.6-luna"],
                              },
                            },
                          }),
                    },
                  },
                }
              : {}),
            // Ceiling and control publish a change that still permits write.
            tools: { deny: scenario === "published-deny" ? ["write"] : ["exec"] },
          });
          storming = scenario === "publication-storm";
          revoked = scenario === "revoked-producer" || scenario === "scheduled-revoked";
          releaseFirst.resolve();
          await expect(first.settled).resolves.toMatchObject({ status: "completed" });
          const executes =
            scenario !== "publication-storm" &&
            !scenario.startsWith("scheduled-model-") &&
            scenario !== "scheduled-subagent-locked" &&
            !revoked;
          const completedOutcome = await completion.settled;
          expect(completedOutcome, completedOutcome.error).toMatchObject({
            status: executes ? "completed" : "failed",
            executionStarted: executes || scenario === "scheduled-subagent-locked",
          });
          expect(prompts).toHaveLength(
            scenario === "scheduled-subagent-default"
              ? 3
              : executes || scenario === "scheduled-subagent-locked"
                ? 2
                : 1,
          );
          if (scenario === "scheduled-model-revoked") {
            expect(completedOutcome.error).toContain(
              "automation model override 'mock-openai/gpt-5.6-sol' rejected by agents.defaults.modelPolicy.allow",
            );
          }
          if (scenario === "scheduled-model-malformed") {
            expect(completedOutcome.error).toContain('Invalid model override "openai/"');
          }
          if (executes) {
            expect(prompts[1]).toContain("Background exec completed");
          }
          if (scenario === "scheduled-control" || scenario === "scheduled-subagent-default") {
            expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toMatchObject({
              provider: "mock-openai",
              model: "gpt-5.6-sol",
            });
          }
          if (scenario === "scheduled-subagent-default") {
            expect(runEmbeddedAgentMock.mock.calls[2]?.[0]).toMatchObject({
              provider: "mock-openai",
              model: "gpt-5.6-luna",
            });
            const saved = await readSessionEntryInWorker(scope);
            expect(saved?.providerOverride).toBeUndefined();
            expect(saved?.modelOverride).toBeUndefined();
          }
          if (scenario === "scheduled-gmail-default") {
            expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toMatchObject({
              provider: "mock-openai",
              model: "gpt-5.6-sol",
              thinkLevel: "high",
            });
            expect(await readSessionEntryInWorker(scope)).toMatchObject({
              providerOverride: "mock-openai",
              modelOverride: "gpt-5.6-luna",
              thinkingLevel: "off",
            });
          }
          if (scenario === "scheduled-subagent-locked") {
            expect(completedOutcome.error).toBe(
              "⚠️ This model was not found. Choose another model in the Control UI or run `openclaw configure`.",
            );
            expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toMatchObject({
              provider: "mock-openai",
              model: "gpt-5.6-luna",
            });
            expect(await readSessionEntryInWorker(scope)).toMatchObject({
              modelSelectionLocked: true,
            });
          }
          if (scheduledAccount) {
            expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toMatchObject({
              provider: scheduledProvider,
              model: boundAccount ? "gpt-5.6-luna" : "gpt-5.6-sol",
              authProfileId:
                scheduledProvider === "mock-openai"
                  ? "mock-openai:conversation"
                  : "mock-other:automation",
            });
            expect(await readSessionEntryInWorker(scope)).toMatchObject({
              authProfileOverride: missingDestinationProfileId ?? "mock-openai:conversation",
              authProfileOverrideSource: "user",
              authProfileOverrideCompactionCount: 2,
              ...(boundAccount ? { modelSelectionLocked: true } : {}),
            });
          }
          // Final effect: only the unrestricted control reaches the filesystem.
          const written = await fs.readFile(filePath, "utf8").catch(() => undefined);
          expect(written).toBe(
            scenario === "allow-control" ||
              scenario === "scheduled-control" ||
              scenario === "scheduled-subagent-default" ||
              scenario === "scheduled-gmail-default" ||
              scheduledAccount
              ? "written\n"
              : undefined,
          );
          if (scenario === "allow-control") {
            const completed = expectDefined(
              await readSessionEntryInWorker(scope),
              "completed source",
            );
            expect(completed.restartRecoveryTerminalRunIds).toContain("exec:readmission-process");
            await fs.writeFile(filePath, "retained after completion\n");
            replay = enqueueSessionEventForHost("Background exec completed", {
              ...scope,
              source: "exec",
              sourceTurnId: "exec:readmission-process",
              expectedTarget: await captureSessionEventTargetForHost(
                scope.agentId,
                scope.sessionKey,
              ),
              abortSignal: signal,
              deliver: false,
            });
            await expect(replay.settled).resolves.toMatchObject({
              executionStarted: false,
              delivered: false,
            });
            expect(prompts).toHaveLength(2);
            expect(await fs.readFile(filePath, "utf8")).toBe("retained after completion\n");
            expect((await readSessionEntryInWorker(scope))?.restartRecoveryTerminalRunIds).toEqual(
              completed.restartRecoveryTerminalRunIds,
            );
            expect(replay.cancel()).toBe(false);
          }
          // Settled either way: nothing is left for a later ordinary turn to drain.
          expect(completion.cancel()).toBe(false);
          expect(sourceReferences).toBe(0);
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
        } finally {
          storming = false;
          revoked = false;
          releaseFirst.resolve();
          await Promise.allSettled([first.settled, completion?.settled, replay?.settled]);
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
        }
      },
    );
  },
);

it("rebuilds queued Gmail content under the readmitted external-content policy", async ({
  signal,
}) => {
  await withOpenClawTestState(
    { label: "scheduled-gmail-readmission", env: { OPENCLAW_TEST_FAST: "0" } },
    async (state) => {
      const config = completionConfig(state.workspaceDir);
      config.hooks = { gmail: { allowUnsafeExternalContent: true } };
      setRuntimeConfigSnapshot(config);
      await state.writeConfig(config);
      openOpenClawStateDatabase();
      const scope = { agentId: "main", sessionKey: "agent:main:hook:gmail:readmission" };
      await replaceSessionEntry(scope, {
        sessionId: "gmail-readmission",
        lifecycleRevision: "original",
        permissionMode: "full",
        updatedAt: Date.now(),
      });
      const firstStarted = createDeferred();
      const releaseFirst = createDeferred();
      const queued = createDeferred();
      const prompts: string[] = [];
      runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
        prompts.push(params.prompt);
        await startRun(params);
        if (prompts.length === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
        }
        return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
      });
      const first = enqueueSessionEventForHost("First admitted work", {
        ...scope,
        source: "task",
        expectedTarget: await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey),
        abortSignal: signal,
        deliver: false,
      });
      let scheduled: ReturnType<typeof runCronSessionTurn> | undefined;
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            firstStarted.promise,
            first.settled,
            "first turn never started",
          ),
          signal,
        );
        scheduled = runCronSessionTurn({
          ...TEST_SCHEDULED_TURN,
          ...scope,
          cfg: config,
          job: makeCronJob({
            id: "gmail-policy-readmission",
            name: "Queued Gmail report",
            sessionTarget: `session:${scope.sessionKey}`,
            delivery: { mode: "none" },
            payload: { kind: "agentTurn", message: "Summarize this synthetic email." },
          }),
          text: "Summarize this synthetic email.",
          deliveryAttemptFence: null,
          abortSignal: signal,
          onLaneWait(info) {
            if (info?.waiting) {
              queued.resolve();
            }
          },
        });
        await withinTest(
          awaitGateBeforeSettlement(queued.promise, scheduled, "scheduled turn never queued"),
          signal,
        );
        setRuntimeConfigSnapshot({
          ...config,
          hooks: { gmail: { allowUnsafeExternalContent: false } },
        });
        releaseFirst.resolve();
        await expect(first.settled).resolves.toMatchObject({ status: "completed" });
        await expect(scheduled).resolves.toMatchObject({ status: "ok", executionStarted: true });
        expect(prompts).toHaveLength(2);
        const prompt = expectDefined(prompts[1], "readmitted scheduled prompt");
        expect(prompt).toMatch(
          /<<<EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>[\s\S]*Summarize this synthetic email\.[\s\S]*<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>/,
        );
        expect(prompt).toContain("Job ID: gmail-policy-readmission");
        expect(prompt).toContain("Queued Gmail report");
        expect(prompt).toContain("Source: Email");
        expect(prompt).toContain("Current time:");
        expect(prompt).toContain("Reference UTC:");
        expect(prompt.match(/This is an unattended scheduled run\./g)).toHaveLength(1);
        expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
      } finally {
        releaseFirst.resolve();
        await Promise.allSettled([first.settled, scheduled]);
        await drainGlobalSingletonLifecycleState("restart");
        resetSystemEventsForTest();
      }
    },
  );
});

it.for(["changed", "unchanged", "no-delivery"] as const)(
  "revalidates the scheduled message destination with a %s implicit route",
  async (scenario, { signal }) => {
    await withOpenClawTestState(
      { label: "scheduled-message-route", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const config = completionConfig(state.workspaceDir);
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        const registry = captureActivePluginRegistrySnapshot();
        const currentRegistry = expectDefined(registry.activeRegistry, "active plugin registry");
        const sendText = vi
          .fn<NonNullable<ChannelOutboundAdapter["sendText"]>>()
          .mockResolvedValue({
            channel: "telegram",
            messageId: "scheduled-message",
          });
        const channels = createTestRegistry([
          {
            pluginId: "telegram",
            source: "test",
            plugin: {
              ...createChannelTestPluginBase({ id: "telegram" }),
              messaging: {
                normalizeTarget: (raw) => raw,
                targetResolver: { looksLikeId: (raw) => /^-10000[12]$/.test(raw) },
              },
              actions: { describeMessageTool: () => ({ actions: ["send"] }) },
              outbound: { deliveryMode: "direct", sendText },
            } satisfies ChannelPlugin,
          },
        ]);
        setActivePluginRegistry({
          ...currentRegistry,
          channels: [
            ...currentRegistry.channels.filter((entry) => entry.plugin.id !== "telegram"),
            ...channels.channels,
          ],
          channelSetups: [
            ...currentRegistry.channelSetups.filter((entry) => entry.plugin.id !== "telegram"),
            ...channels.channelSetups,
          ],
        });
        const scope = { agentId: "main", sessionKey: "agent:main:scheduled-message-route" };
        const route = { channel: "telegram", to: "-100001", accountId: "default" };
        await replaceSessionEntry(scope, {
          sessionId: "scheduled-message-route",
          lifecycleRevision: "original",
          permissionMode: "full",
          delivery: normalizeSessionDeliveryState({ context: route }),
          updatedAt: Date.now(),
        });
        const firstStarted = createDeferred();
        const releaseFirst = createDeferred();
        const queued = createDeferred();
        let nativeCalls = 0;
        let messageError: unknown;
        runEmbeddedAgentMock
          .mockReset()
          .mockImplementation(async (params: RunEmbeddedAgentInternalParams) => {
            await startRun(params);
            if (++nativeCalls === 1) {
              firstStarted.resolve();
              await releaseFirst.promise;
            } else {
              const tool = createMessageTool({
                config: params.config,
                agentId: params.agentId,
                runId: params.runId,
                sessionId: params.sessionId,
                agentSessionKey: params.sessionKey,
                agentAccountId: route.accountId,
                currentChannelProvider: route.channel,
                messageActionTurnCapability: params.messageActionTurnCapability,
                requireExplicitTarget: true,
              });
              try {
                await tool.execute("scheduled-send", {
                  action: "send",
                  channel: route.channel,
                  target: route.to,
                  message: "Scheduled report",
                });
              } catch (error) {
                messageError = error;
              }
            }
            return {
              payloads: [{ text: "NO_REPLY" }],
              meta: { durationMs: 1 },
              didSendViaMessagingTool: sendText.mock.calls.length > 0,
              messagingToolSentTargets: sendText.mock.calls.map(([sent]) => ({
                tool: "message",
                provider: "telegram",
                to: sent.to,
                accountId: sent.accountId ?? undefined,
              })),
            };
          });
        const first = enqueueSessionEventForHost("First admitted work", {
          ...scope,
          source: "task",
          expectedTarget: await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey),
          abortSignal: signal,
          deliver: false,
        });
        let scheduled: ReturnType<typeof runCronSessionTurn> | undefined;
        try {
          await withinTest(
            awaitGateBeforeSettlement(
              firstStarted.promise,
              first.settled,
              "first turn never started",
            ),
            signal,
          );
          scheduled = runCronSessionTurn({
            ...TEST_SCHEDULED_TURN,
            ...scope,
            cfg: config,
            job: makeCronJob({
              sessionTarget: `session:${scope.sessionKey}`,
              delivery: { mode: scenario === "no-delivery" ? "none" : "announce" },
            }),
            text: "Send the scheduled report",
            deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent() {} },
            abortSignal: signal,
            onLaneWait(info) {
              if (info?.waiting) {
                queued.resolve();
              }
            },
          });
          await withinTest(
            awaitGateBeforeSettlement(queued.promise, scheduled, "scheduled turn never queued"),
            signal,
          );
          if (scenario !== "unchanged") {
            await patchSessionEntryCore(scope, () => ({
              delivery: normalizeSessionDeliveryState({ context: { ...route, to: "-100002" } }),
            }));
          }
          releaseFirst.resolve();
          await first.settled;
          const outcome = await scheduled;
          expect(nativeCalls).toBe(2);
          if (scenario === "changed") {
            expect(outcome.delivered).toBe(false);
            expect(sendText).not.toHaveBeenCalled();
            expect(String(messageError)).toContain("Automation delivery policy or route changed");
          } else {
            expect(messageError).toBeUndefined();
            expect(sendText).toHaveBeenCalledOnce();
            expect(sendText.mock.calls[0]?.[0].to).toBe(route.to);
            if (scenario === "unchanged") {
              expect(outcome.delivered).toBe(true);
            }
          }
        } finally {
          releaseFirst.resolve();
          await Promise.allSettled([first.settled, scheduled]);
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
          restoreActivePluginRegistrySnapshot(registry);
        }
      },
    );
  },
);

it.for(["transport", "agent", "context-overflow"] as const)(
  "records a scheduled %s failure with its cause and available usage",
  async (failureKind, { signal }) => {
    await withOpenClawTestState(
      { label: "session-event-delivery", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const config = completionConfig(state.workspaceDir);
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        const scope = { agentId: "main", sessionKey: "agent:main:scheduled-delivery" };
        const route = { channel: "telegram", to: "-100001", accountId: "scheduled" };
        await replaceSessionEntry(scope, {
          sessionId: "scheduled-delivery",
          lifecycleRevision: "original",
          permissionMode: "full",
          delivery: normalizeSessionDeliveryState({ context: route }),
          updatedAt: Date.now(),
        });
        // Inject only this transport failure; sibling cases retain normal silent delivery.
        using routePreparedReply = vi.spyOn(routedReplies, "routePreparedReply").mockResolvedValue({
          ok: false,
          delivered: false,
          error: "transport unavailable",
        });
        runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
          await startRun(params);
          if (failureKind === "context-overflow") {
            return {
              payloads: [],
              meta: {
                durationMs: 1,
                error: {
                  kind: "context_overflow",
                  message:
                    "400 The prompt is too long: 203557, model maximum context length: 196607",
                },
              },
            };
          }
          return {
            payloads: [{ text: "The report is complete." }],
            meta: {
              durationMs: 1,
              ...(failureKind === "agent"
                ? {
                    error: {
                      kind: "retry_limit" as const,
                      message: "Provider retry limit reached",
                    },
                  }
                : {}),
              agentMeta: {
                sessionId: params.sessionId,
                provider: "openai",
                model: "gpt-5.6-sol",
                usage: { input: 20, output: 5, cacheRead: 10, total: 35 },
              },
            },
          };
        });
        const receipt = enqueueSessionEventForHost("Write the report", {
          ...scope,
          source: "cron",
          expectedTarget: await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey),
          deliveryContext: route,
          abortSignal: signal,
          deliver: failureKind === "transport",
          scheduledAutomation: {
            ...TEST_SCHEDULED_TURN,
            job: makeCronJob({ sessionTarget: `session:${scope.sessionKey}` }),
          },
        });
        try {
          const outcome = await receipt.settled;
          expect(outcome, outcome.error).toMatchObject({
            status: failureKind === "transport" ? "completed" : "failed",
            executionStarted: true,
            delivered: false,
            ...(failureKind === "transport"
              ? { deliveryAttempted: true, deliveryError: "transport unavailable" }
              : {
                  error:
                    failureKind === "agent"
                      ? "Provider retry limit reached"
                      : expect.stringContaining("Auto-compaction could not recover this turn"),
                  deliveryAttempted: false,
                }),
            ...(failureKind !== "context-overflow"
              ? {
                  automationResult: {
                    provider: "openai",
                    model: "gpt-5.6-sol",
                    usage: {
                      input_tokens: 20,
                      output_tokens: 5,
                      cache_read_tokens: 10,
                      total_tokens: 35,
                    },
                  },
                }
              : {}),
          });
          if (failureKind === "context-overflow") {
            expect(outcome.error).toContain("use /compact");
            expect(outcome.error).toContain("use /new");
            expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
          }
          if (failureKind === "transport") {
            expect(routePreparedReply).toHaveBeenCalled();
          } else {
            expect(routePreparedReply).not.toHaveBeenCalled();
          }
        } finally {
          receipt.cancel();
          await receipt.settled;
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
        }
      },
    );
  },
);
