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
import { createMessageTool } from "../../agents/tools/message-tool-execution.js";
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
import type { CronStoredJob } from "../../cron/types.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import { createOwnedTestInstance } from "../../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../../plugins/plugin-invocation-scope.js";
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
import { openEventToolHost, startEmbeddedTurn } from "./session-event.test-support.js";
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

/** Uses the real managed write tool; the model decision alone is mocked. */
async function attemptRealWrite(
  params: RunEmbeddedAgentParams,
  filePath: string,
  operatorAuthority?: AdmittedRunOperatorAuthority,
) {
  const { admittedRunContext, tools, close } = await openEventToolHost(params, "reply admission");
  try {
    if (operatorAuthority) {
      expect(readAdmittedRunOperatorAuthority(admittedRunContext)?.profileId).toBe(
        "original-guest",
      );
    }
    await tools
      .find((tool) => tool.name === "write")
      ?.execute("readmission-write", { path: filePath, content: "written\n" })
      .catch(() => undefined);
  } finally {
    close();
  }
}

it("executes a recovery event after its producer's plugin scope closes", async ({ signal }) => {
  await withOpenClawTestState(
    { label: "session-event-plugin-readmission", env: { OPENCLAW_TEST_FAST: "0" } },
    async (state) => {
      const config = completionConfig(state.workspaceDir);
      setRuntimeConfigSnapshot(config);
      await state.writeConfig(config);
      openOpenClawStateDatabase();
      const target = { agentId: "main", sessionKey: "agent:main:plugin-readmission" };
      await replaceSessionEntry(target, {
        sessionId: "plugin-readmission",
        lifecycleRevision: "original",
        permissionMode: "full",
        updatedAt: Date.now(),
      });
      const plugin = createOwnedTestInstance("event-source");
      const invocations = new PluginInvocationScope(plugin.owner!.registry!, [plugin], {
        retained: true,
      });
      const assertSourceCurrent = plugin.wrap(() => signal.throwIfAborted());
      const oldCallback = invocations.wrap(assertSourceCurrent);
      const filePath = path.join(state.workspaceDir, "recovery-event.txt");
      runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
        await attemptRealWrite(params, filePath);
        return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
      });
      let receipt: ReturnType<typeof enqueueSessionEventForHost> | undefined;
      try {
        const expectedTarget = await captureSessionEventTargetForHost(
          target.agentId,
          target.sessionKey,
        );
        receipt = invocations.run(() =>
          enqueueSessionEventForHost("Resume required work", {
            ...target,
            source: "restart",
            expectedTarget,
            assertCurrent: assertSourceCurrent,
            abortSignal: signal,
            deliver: false,
          }),
        );
        invocations.release();
        expect(() => oldCallback()).toThrow("Plugin event-source consumer is closed");
        // Publication before admission forces the rejection handler to re-admit the occurrence.
        setRuntimeConfigSnapshot({ ...config, tools: { deny: ["exec"] } });
        const outcome = await withinTest(receipt.settled, signal);
        expect(outcome, outcome.error).toMatchObject({
          status: "completed",
          executionStarted: true,
        });
        expect(await fs.readFile(filePath, "utf8")).toBe("written\n");
        expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
        expect(runEmbeddedAgentMock.mock.calls[0]?.[0].config?.tools?.deny).toEqual(["exec"]);
      } finally {
        invocations.release();
        await Promise.allSettled([receipt?.settled]);
        await drainGlobalSingletonLifecycleState("restart");
        resetSystemEventsForTest();
      }
    },
  );
});

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
  "scheduled-failure-transport",
  "scheduled-failure-agent",
  "scheduled-failure-context-overflow",
] as const)(
  "re-admits accepted deferred work after a config publication: %s",
  async (scenario, { signal }) => {
    await withOpenClawTestState(
      { label: "session-event-config-readmission", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const config = completionConfig(state.workspaceDir);
        const scheduled = scenario.startsWith("scheduled-");
        const failure = scenario.startsWith("scheduled-failure-");
        const transport = scenario === "scheduled-failure-transport";
        const overflow = scenario === "scheduled-failure-context-overflow";
        using routePreparedReply = failure
          ? vi.spyOn(routedReplies, "routePreparedReply").mockResolvedValue({
              ok: false,
              delivered: false,
              error: "transport unavailable",
            })
          : undefined;
        const gmail = scenario === "scheduled-gmail-default";
        const locked = scenario === "scheduled-subagent-locked";
        const scheduledAccount = scenario.startsWith("scheduled-account-");
        const boundAccount = scenario === "scheduled-account-bound-unavailable";
        const scheduledProvider =
          scenario === "scheduled-account-cross-provider" ? "mock-other" : "mock-openai";
        const explicitScheduledModel =
          scenario === "scheduled-control" ||
          scenario.startsWith("scheduled-model-") ||
          scheduledAccount;
        const scheduledSubagent = scenario.startsWith("scheduled-subagent-");
        const defaults = expectDefined(config.agents?.defaults, "completion agent defaults");
        if (explicitScheduledModel || scheduledSubagent || gmail) {
          defaults.modelPolicy = {
            allow:
              scheduledProvider === "mock-other"
                ? ["mock-openai/*", "mock-other/*"]
                : ["mock-openai/*"],
          };
          if (scheduledSubagent) {
            defaults.subagents = { model: "mock-openai/gpt-5.6-luna" };
          }
          defaults.models = {
            ...defaults.models,
            "mock-openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
            [`${scheduledProvider}/gpt-5.6-sol`]: { agentRuntime: { id: "openclaw" } },
          };
        }
        if (gmail) {
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
        const accountId = failure ? "scheduled" : "readmission";
        const route = { channel: "telegram", to: "-100001", accountId };
        await replaceSessionEntry(scope, {
          sessionId: "config-readmission",
          lifecycleRevision: "original",
          permissionMode: "full",
          authProfileOverride: scheduledAccount ? "mock-openai:conversation" : undefined,
          authProfileOverrideSource: scheduledAccount ? "user" : undefined,
          authProfileOverrideCompactionCount: scheduledAccount ? 2 : undefined,
          modelSelectionLocked: locked || boundAccount ? true : undefined,
          providerOverride: gmail ? "mock-openai" : undefined,
          modelOverride: gmail ? "gpt-5.6-luna" : undefined,
          thinkingLevel: gmail ? "off" : undefined,
          delivery: normalizeSessionDeliveryState({ context: route }),
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
        });
        let sourceReferences = 1;
        const operatorAuthority =
          scenario === "allow-control" || (scheduled && !failure)
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
        runEmbeddedAgentMock
          .mockReset()
          .mockImplementation(async (params: RunEmbeddedAgentParams) => {
            prompts.push(params.prompt);
            if (!failure && prompts.length === 1) {
              await startEmbeddedTurn(params, "reply admission");
              firstStarted.resolve();
              await releaseFirst.promise;
            } else if (failure) {
              await startEmbeddedTurn(params, "reply admission");
              return {
                payloads: overflow ? [] : [{ text: "The report is complete." }],
                meta: {
                  durationMs: 1,
                  error: overflow
                    ? {
                        kind: "context_overflow",
                        message:
                          "400 The prompt is too long: 203557, model maximum context length: 196607",
                      }
                    : transport
                      ? undefined
                      : { kind: "retry_limit", message: "Provider retry limit reached" },
                  agentMeta: overflow
                    ? undefined
                    : {
                        sessionId: params.sessionId,
                        provider: "openai",
                        model: "gpt-5.6-sol",
                        usage: { input: 20, output: 5, cacheRead: 10, total: 35 },
                      },
                },
              };
            } else if (scheduledSubagent && prompts.length === 2) {
              if (locked) {
                await startEmbeddedTurn(params, "reply admission");
              }
              throw new FailoverError("Synthetic scheduled primary unavailable", {
                reason: "model_not_found",
                provider: params.provider,
                model: params.model,
              });
            } else {
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
        const first = failure
          ? undefined
          : enqueueSessionEventForHost("First admitted work", {
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
          if (first) {
            await expect(first.accepted).resolves.toEqual({ ok: true });
            await withinTest(firstStarted.promise, signal);
          }
          if (scheduledAccount) {
            expect(runEmbeddedAgentMock.mock.calls[0]?.[0].authProfileId).toBe(
              "mock-openai:conversation",
            );
          }
          if (boundAccount) {
            await patchSessionEntryCore(scope, () => ({
              authProfileOverride: missingDestinationProfileId,
            }));
          }
          const payload: Extract<CronStoredJob["payload"], { kind: "agentTurn" }> = {
            kind: "agentTurn",
            message: "Background exec completed",
          };
          if (gmail) {
            payload.externalContentSource = "gmail";
          }
          if (locked) {
            payload.fallbacks = ["mock-openai/gpt-5.6-sol"];
          }
          if (explicitScheduledModel) {
            payload.model =
              scenario === "scheduled-model-malformed"
                ? "openai/"
                : `${scheduledProvider}/gpt-5.6-sol`;
          }
          completion = enqueueSessionEventForHost("Background exec completed", {
            ...scope,
            source: failure ? "cron" : "exec",
            deliver: failure ? transport : undefined,
            // The real exec producer's durable source identity.
            sourceTurnId: failure ? undefined : "exec:readmission-process",
            deliveryContext: failure ? route : undefined,
            // The producing turn's tool ceiling travels with the captured target.
            expectedTarget:
              scenario === "retained-ceiling" ? { ...target, toolsAllow: ["read"] } : target,
            abortSignal: signal,
            scheduledAutomation: scheduled
              ? {
                  ...TEST_SCHEDULED_TURN,
                  job: {
                    ...makeCronJob({
                      id: "scheduled-readmission",
                      sessionTarget: `session:${scope.sessionKey}`,
                      wakeMode: "now",
                      payload,
                    }),
                    inferenceBinding,
                  },
                  operatorAuthority,
                  assertCurrent: () => {
                    if (revoked) {
                      throw new Error("Scheduled source retired");
                    }
                  },
                }
              : undefined,
            assertCurrent: () => {
              if (revoked && !scheduled) {
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
          if (!failure) {
            const nextDefaults = { ...defaults };
            if (scenario === "scheduled-model-revoked") {
              nextDefaults.modelPolicy = { allow: ["mock-openai/gpt-5.6-luna"] };
            } else if (scheduledSubagent) {
              nextDefaults.subagents = {
                model: {
                  primary: "mock-openai/gpt-5.6-sol",
                  fallbacks: ["mock-openai/gpt-5.6-luna"],
                },
              };
            }
            setRuntimeConfigSnapshot({
              ...config,
              agents: { ...config.agents, defaults: nextDefaults },
              ...(gmail
                ? {
                    hooks: {
                      gmail: { model: "mock-openai/gpt-5.6-sol", thinking: "high" as const },
                    },
                  }
                : {}),
              // Ceiling and control publish a change that still permits write.
              tools: { deny: scenario === "published-deny" ? ["write"] : ["exec"] },
            });
          }
          storming = scenario === "publication-storm";
          revoked = scenario === "revoked-producer" || scenario === "scheduled-revoked";
          releaseFirst.resolve();
          if (first) {
            await expect(first.settled).resolves.toMatchObject({ status: "completed" });
          }
          const executes =
            scenario !== "publication-storm" &&
            !scenario.startsWith("scheduled-model-") &&
            scenario !== "scheduled-subagent-locked" &&
            !revoked;
          const completedOutcome = await completion.settled;
          expect(completedOutcome, completedOutcome.error).toMatchObject({
            status: executes && (!failure || transport) ? "completed" : "failed",
            executionStarted: executes || locked,
          });
          expect(prompts).toHaveLength(
            failure
              ? 1
              : scenario === "scheduled-subagent-default"
                ? 3
                : executes || locked
                  ? 2
                  : 1,
          );
          if (failure) {
            expect(completedOutcome).toMatchObject({
              delivered: false,
              deliveryAttempted: transport,
            });
            if (transport) {
              expect(completedOutcome.deliveryError).toBe("transport unavailable");
              expect(routePreparedReply).toHaveBeenCalled();
            } else {
              expect(completedOutcome.error).toEqual(
                overflow
                  ? expect.stringContaining("Auto-compaction could not recover this turn")
                  : "Provider retry limit reached",
              );
              expect(routePreparedReply).not.toHaveBeenCalled();
            }
            if (overflow) {
              expect(completedOutcome.error).toContain("use /compact");
              expect(completedOutcome.error).toContain("use /new");
            } else {
              expect(completedOutcome.automationResult).toMatchObject({
                provider: "openai",
                model: "gpt-5.6-sol",
                usage: {
                  input_tokens: 20,
                  output_tokens: 5,
                  cache_read_tokens: 10,
                  total_tokens: 35,
                },
              });
            }
          }
          if (scenario === "scheduled-model-revoked") {
            expect(completedOutcome.error).toContain(
              "automation model override 'mock-openai/gpt-5.6-sol' rejected by agents.defaults.modelPolicy.allow",
            );
          }
          if (scenario === "scheduled-model-malformed") {
            expect(completedOutcome.error).toContain('Invalid model override "openai/"');
          }
          if (executes && !failure) {
            expect(prompts[1]).toContain("Background exec completed");
          }
          const selectedProfile =
            scheduledProvider === "mock-openai"
              ? "mock-openai:conversation"
              : "mock-other:automation";
          if (scenario === "scheduled-control" || scheduledSubagent || gmail || scheduledAccount) {
            expect(runEmbeddedAgentMock.mock.calls[1]?.[0]).toMatchObject({
              provider: scheduledProvider,
              model: locked || boundAccount ? "gpt-5.6-luna" : "gpt-5.6-sol",
              ...(gmail ? { thinkLevel: "high" } : {}),
              ...(scheduledAccount ? { authProfileId: selectedProfile } : {}),
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
          if (gmail) {
            expect(await readSessionEntryInWorker(scope)).toMatchObject({
              providerOverride: "mock-openai",
              modelOverride: "gpt-5.6-luna",
              thinkingLevel: "off",
            });
          }
          if (locked) {
            expect(completedOutcome.error).toBe(
              "⚠️ This model was not found. Choose another model in the Control UI or run `openclaw configure`.",
            );
            expect((await readSessionEntryInWorker(scope))?.modelSelectionLocked).toBe(true);
          }
          if (scheduledAccount) {
            expect(await readSessionEntryInWorker(scope)).toMatchObject({
              authProfileOverride: missingDestinationProfileId ?? "mock-openai:conversation",
              authProfileOverrideSource: "user",
              authProfileOverrideCompactionCount: 2,
              ...(boundAccount ? { modelSelectionLocked: true } : {}),
            });
          }
          // Final effect: only the unrestricted control reaches the filesystem.
          expect(await fs.readFile(filePath, "utf8").catch(() => undefined)).toBe(
            scenario === "allow-control" ||
              scenario === "scheduled-control" ||
              scenario === "scheduled-subagent-default" ||
              gmail ||
              scheduledAccount
              ? "written\n"
              : undefined,
          );
          if (scenario === "allow-control") {
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
          await Promise.allSettled([first?.settled, completion?.settled, replay?.settled]);
          await drainGlobalSingletonLifecycleState("restart");
          resetSystemEventsForTest();
        }
      },
    );
  },
);

it.for(["changed", "unchanged", "no-delivery", "gmail-policy"] as const)(
  "revalidates queued scheduled content and destination: %s",
  async (scenario, { signal }) => {
    await withOpenClawTestState(
      { label: "scheduled-message-route", env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const gmail = scenario === "gmail-policy";
        const config = completionConfig(state.workspaceDir);
        if (gmail) {
          config.hooks = { gmail: { allowUnsafeExternalContent: true } };
        }
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        openOpenClawStateDatabase();
        const registry = captureActivePluginRegistrySnapshot();
        const currentRegistry = expectDefined(registry.activeRegistry, "active plugin registry");
        const sendText = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>(async () => ({
          channel: "telegram",
          messageId: "scheduled-message",
        }));
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
        const scope = {
          agentId: "main",
          sessionKey: gmail
            ? "agent:main:hook:gmail:readmission"
            : "agent:main:scheduled-message-route",
        };
        const route = { channel: "telegram", to: "-100001", accountId: "default" };
        await replaceSessionEntry(scope, {
          sessionId: "scheduled-message-route",
          lifecycleRevision: "original",
          permissionMode: "full",
          ...(gmail ? {} : { delivery: normalizeSessionDeliveryState({ context: route }) }),
          updatedAt: Date.now(),
        });
        const firstStarted = createDeferred();
        const releaseFirst = createDeferred();
        const queued = createDeferred();
        const prompts: string[] = [];
        let messageError: unknown;
        runEmbeddedAgentMock
          .mockReset()
          .mockImplementation(async (params: RunEmbeddedAgentInternalParams) => {
            prompts.push(params.prompt);
            await startEmbeddedTurn(params, "reply admission");
            if (prompts.length === 1) {
              firstStarted.resolve();
              await releaseFirst.promise;
            } else if (!gmail) {
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
              ...(gmail
                ? {
                    id: "gmail-policy-readmission",
                    name: "Queued Gmail report",
                    payload: { kind: "agentTurn", message: "Summarize this synthetic email." },
                  }
                : {}),
              sessionTarget: `session:${scope.sessionKey}`,
              delivery: { mode: gmail || scenario === "no-delivery" ? "none" : "announce" },
            }),
            text: gmail ? "Summarize this synthetic email." : "Send the scheduled report",
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
          if (gmail) {
            setRuntimeConfigSnapshot({
              ...config,
              hooks: { gmail: { allowUnsafeExternalContent: false } },
            });
          } else if (scenario !== "unchanged") {
            await patchSessionEntryCore(scope, () => ({
              delivery: normalizeSessionDeliveryState({ context: { ...route, to: "-100002" } }),
            }));
          }
          releaseFirst.resolve();
          await expect(first.settled).resolves.toMatchObject({ status: "completed" });
          const outcome = await scheduled;
          expect(prompts).toHaveLength(2);
          if (gmail) {
            expect(outcome).toMatchObject({ status: "ok", executionStarted: true });
            const prompt = expectDefined(prompts[1], "readmitted scheduled prompt");
            expect(prompt).toMatch(
              /<<<EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>[\s\S]*Summarize this synthetic email\.[\s\S]*<<<END_EXTERNAL_UNTRUSTED_CONTENT id="[^"]+">>>/,
            );
            for (const text of [
              "Job ID: gmail-policy-readmission",
              "Queued Gmail report",
              "Source: Email",
              "Current time:",
              "Reference UTC:",
            ]) {
              expect(prompt).toContain(text);
            }
            expect(prompt.match(/This is an unattended scheduled run\./g)).toHaveLength(1);
          } else if (scenario === "changed") {
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
          expect(peekSystemEventEntries(scope.sessionKey)).toEqual([]);
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
