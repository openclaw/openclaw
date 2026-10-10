// Actual chat candidate and cron fallback process proof with owned protocol fixtures; no vendor inference.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../agents/admitted-run-context.js";
import { createAssistantErrorTranscript } from "../../agents/assistant-error-transcript.js";
import { resolveSessionAuthSelection } from "../../agents/auth-profiles/session-override.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import { classifyEmbeddedAgentRunResultForModelFallback } from "../../agents/embedded-agent-runner/result-fallback-classifier.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import { FailoverError } from "../../agents/failover/error.js";
import { createContextEngineLogicalTurnLease } from "../../agents/harness/context-engine-logical-turn.js";
import { withPreparedModelRuntimePluginGenerationScope } from "../../agents/prepared-model-runtime-generation-scope.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { createDefaultDeps } from "../../cli/deps.js";
import { bindConfiguredModelAuthProfileScope } from "../../config/sessions/auth-profile-override-provenance.js";
import {
  replaceSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { executeCronRun } from "../../cron/isolated-agent/run-executor.js";
import { prepareCronRunContext } from "../../cron/isolated-agent/run-prepare.js";
import type { CronStoredJob } from "../../cron/types.js";
import {
  getAgentEventLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { formatErrorMessage, hasErrnoCode } from "../../infra/errors.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { initializeGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
  disposePluginRegistryInstances,
} from "../../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { createPluginRecord } from "../../plugins/status.test-fixtures.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import { resolveRunAuthProfile } from "./agent-runner-auth-profile.js";
import { runCliFallbackCandidate } from "./agent-runner-cli-candidate.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import type { AgentFallbackCandidateCommonParams } from "./agent-runner-fallback-cycle.types.js";
import { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import { createAgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import type { FollowupRun } from "./queue.js";

const SELF_FIXTURE_PACKAGE_JSON = fileURLToPath(
  new URL("../../../test/fixtures/chat-cli-account/package.json", import.meta.url),
);
const SELF_FIXTURE_CLI_SOURCE = fileURLToPath(
  new URL("../../../test/fixtures/chat-cli-account/cli.mjs", import.meta.url),
);

const CONFIGURED_PROFILE = "anthropic:configured-fixture";
const CLI_PROFILE = "google:cli-fixture";
const runtime = "google-gemini-cli";
const model = "fixture-model";
const noActivity = async () => {};
const fixtureBackends = resolveGlobalMap<string, CliBackendPlugin[]>(
  Symbol.for("openclaw.test.cliAccountFixtureBackends"),
);

// Run each stage with an unchanged positive control before interpreting refusals.
it.each([
  { kind: "chat", stage: "placement", pin: null },
  { kind: "chat", stage: "placement", pin: "user" },
  { kind: "chat", stage: "placement", pin: "user-link" },
  { kind: "chat", stage: "before-execution", pin: null },
  { kind: "chat", stage: "before-execution", pin: "user" },
  { kind: "chat", stage: "before-execution", pin: "user-link" },
  { kind: "cron", stage: "before-execution", pin: null },
  { kind: "cron", stage: "before-execution", pin: "user-link" },
] as const)(
  "protects $kind $pin intent at $stage before actual CLI launch",
  async ({ kind, stage, pin }) => {
    await withOpenClawTestState({ label: "chat-cli-account-process" }, async (state) => {
      const previousRegistry = captureActivePluginRegistrySnapshot();
      const entered = createDeferred();
      const release = createDeferred();
      const packageRoot = path.join(state.root, "self-cli-package");
      const command = path.join(packageRoot, "cli.mjs");
      const receipt = path.join(state.root, "cli-launches.jsonl");
      await fs.mkdir(packageRoot);
      await fs.copyFile(SELF_FIXTURE_PACKAGE_JSON, path.join(packageRoot, "package.json"));
      const cliSource = await fs.readFile(SELF_FIXTURE_CLI_SOURCE, "utf8");
      await fs.writeFile(
        command,
        `#!${process.execPath}\n` + cliSource.replace(/^#![^\n]*\n/, ""),
        {
          mode: 0o755,
        },
      );
      if (kind === "cron") {
        for (const name of ["openclaw.plugin.json", "plugin.cjs"]) {
          await fs.copyFile(
            fileURLToPath(
              new URL(`../../../test/fixtures/chat-cli-account/${name}`, import.meta.url),
            ),
            path.join(packageRoot, name),
          );
        }
      }
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            model: {
              primary: `anthropic/primary-fixture@${CONFIGURED_PROFILE}`,
              fallbacks: [`google/${model}`],
            },
            models: {
              "anthropic/primary-fixture": { agentRuntime: { id: "claude-cli" } },
              [`google/${model}`]: { agentRuntime: { id: runtime } },
            },
          },
        },
        models: {
          providers: Object.fromEntries(
            (
              [
                ["anthropic", "primary-fixture"],
                ["google", model],
              ] as const
            ).map(([provider, id]) => [
              provider,
              {
                baseUrl: "https://fixture.invalid",
                api: "openai-completions" as const,
                models: [
                  {
                    id,
                    name: id,
                    reasoning: false,
                    input: ["text" as const],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 1024,
                  },
                ],
              },
            ]),
          ),
        },
        plugins: {
          allow: ["chat-cli-account-fixture"],
          ...(kind === "cron" ? { load: { paths: [packageRoot] } } : {}),
          entries: {
            "chat-cli-account-fixture": { enabled: true, config: { fixtureKey: command } },
          },
        },
        auth: {
          profiles: {
            [CONFIGURED_PROFILE]: { provider: "anthropic", mode: "api_key" as const },
            [CLI_PROFILE]: { provider: "google", mode: "api_key" as const },
          },
          order: { google: [CLI_PROFILE], anthropic: [CONFIGURED_PROFILE] },
        },
      };
      await state.writeConfig(cfg);
      const agentDir = state.agentDir("main");
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [CONFIGURED_PROFILE]: {
              type: "api_key",
              provider: "anthropic",
              key: "synthetic-anthropic-key",
            },
            [CLI_PROFILE]: { type: "api_key", provider: "google", key: "synthetic-google-key" },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );
      const runId = "chat-cli-account-run";
      const sessionKey = "agent:main:chat-cli-account";
      const target = {
        agentId: "main",
        sessionId: "chat-cli-account-session",
        sessionKey,
        storePath: path.join(state.sessionsDir("main"), "sessions.json"),
      };
      const entry = {
        sessionId: target.sessionId,
        lifecycleRevision: "11111111-1111-4111-8111-111111111111",
        updatedAt: Date.now(),
      };
      await replaceSessionEntry(target, entry);
      const builder = createTestPluginRegistry();
      const record = createPluginRecord({
        id: "chat-cli-account-fixture",
        origin: "workspace",
        source: command,
      });
      builder.registry.plugins.push(record);
      let uninstallPlacement: (() => void) | undefined;
      let preparedRunAdmission: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
      let deferredLifecycle:
        | ReturnType<typeof createDeferredEmbeddedRunLifecycleManager>
        | undefined;
      let contextEngineLogicalTurnLease:
        | Awaited<ReturnType<typeof createContextEngineLogicalTurnLease>>
        | undefined;
      let run: ReturnType<typeof runCliFallbackCandidate> | undefined;
      let closeCron: (() => Promise<void>) | undefined;
      let cronPromptAdmission:
        | Parameters<Parameters<typeof executeCronRun>[0]["onPromptAdmission"]>[0]
        | undefined;
      let cronWinner: string | undefined;
      try {
        const api = builder.createApi(record, { config: cfg, registrationMode: "full" });
        let capturedAuthProfile: string | undefined;
        const destination: CliBackendPlugin = {
          id: runtime,
          modelProvider: "google",
          nativeToolMode: "none",
          runtimeArtifact: {
            kind: "bundled-package-tree",
            packageName: "@openclaw-fixture/chat-auth-node-cli",
            entrypoint: "command",
            nativeExecutableNames: ["chat-auth-node-cli"],
          },
          config: {
            command,
            args: [],
            input: "arg",
            output: "jsonl",
            jsonlDialect: "gemini-stream-json",
            sessionMode: "none",
            systemPromptWhen: "never",
            env: { OPENCLAW_CHAT_AUTH_PROOF_RECEIPT: receipt },
          },
          // Normal public preparation hook only observes selected credential identity.
          // The production auth selector/materializer still owns all credential decisions.
          prepareExecution: async (context) => {
            capturedAuthProfile = context.authProfileId;
            return {
              beforeExecution: async () => {
                if (stage === "before-execution") {
                  entered.resolve();
                  await release.promise;
                }
              },
            };
          },
        };
        if (kind === "chat") {
          api.registerCliBackend(destination);
        }
        if (kind === "cron") {
          const primary: CliBackendPlugin = {
            id: "claude-cli",
            modelProvider: "anthropic",
            nativeToolMode: "none",
            runtimeArtifact: {
              kind: "bundled-package-tree",
              packageName: "@openclaw-fixture/chat-auth-node-cli",
              entrypoint: "command",
              nativeExecutableNames: ["chat-auth-node-cli"],
            },
            config: {
              command,
              args: [],
              input: "arg",
              output: "jsonl",
              jsonlDialect: "gemini-stream-json",
              sessionMode: "none",
              systemPromptWhen: "never",
            },
            prepareExecution: (context) => {
              expect(context.authProfileId).toBe(CONFIGURED_PROFILE);
              throw new FailoverError("Synthetic primary billing refusal", {
                reason: "billing",
                provider: "anthropic",
                model: "primary-fixture",
              });
            },
          };
          fixtureBackends.set(command, [destination, primary]);
        }
        setActivePluginRegistry(
          builder.registry,
          "chat-cli-account-fixture",
          "default",
          state.workspaceDir,
        );
        initializeGlobalHookRunner(builder.registry);
        if (stage === "placement") {
          uninstallPlacement = installSessionPlacementAdmissionProvider({
            assertCompactionSuccessorAllowed: () => {},
            executeLocalTurn: async (_claim, runLocal, assertCurrent) => {
              entered.resolve();
              await release.promise;
              assertCurrent?.();
              return runLocal();
            },
            executeTurn: async (_claim, _params, runLocal) => runLocal(),
          });
        }
        if (kind === "chat") {
          preparedRunAdmission = prepareSystemAgentRunAdmission(
            cfg,
            runId,
            "main",
            "chat-cli-account-process",
          );
          deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
            runId,
            agentId: "main",
            sessionId: target.sessionId,
            sessionKey,
          });
          const followupRun: FollowupRun = {
            prompt: "Synthetic account-bound reply",
            summaryLine: "Synthetic account-bound reply",
            enqueuedAt: Date.now(),
            run: {
              agentId: "main",
              agentDir,
              sessionId: target.sessionId,
              sessionKey,
              sessionFile: path.join(state.root, "logical-session.jsonl"),
              workspaceDir: state.workspaceDir,
              config: cfg,
              provider: "anthropic",
              model: "primary-fixture",
              authProfileId: CONFIGURED_PROFILE,
              authProfileIdSource: "user",
              blockReplyBreak: "message_end",
              timeoutMs: 10_000,
              skillsSnapshot: { prompt: "", skills: [] },
              thinkingCatalog: [{ provider: "google", id: model, input: ["text"] }],
            },
          };
          // Actual provenance producer; this supplies configured candidate facts, not
          // an auth-selector or fallback result. Outer selection is outside this boundary.
          const selection = await resolveSessionAuthSelection({
            cfg,
            provider: "anthropic",
            modelId: "primary-fixture",
            agentId: "main",
            agentDir,
            sessionEntry: entry,
            sessionKey,
            storePath: target.storePath,
            isNewSession: false,
          });
          expect(selection?.profileId).toBe(CONFIGURED_PROFILE);
          expect(selection?.configuredPrimaryProvider).toBe("anthropic");
          followupRun.run.authProfileId = selection?.profileId;
          followupRun.run.authProfileIdSource = selection?.source;
          bindConfiguredModelAuthProfileScope(
            followupRun.run,
            selection?.configuredPrimaryProvider,
          );
          const turn: AgentTurnParams = {
            commandBody: followupRun.prompt,
            followupRun,
            sessionCtx: { Provider: "webchat" },
            opts: { disableTools: true },
            typingSignals: {
              mode: "never",
              shouldStartImmediately: false,
              shouldStartOnMessageStart: false,
              shouldStartOnText: false,
              shouldStartOnReasoning: false,
              signalRunStart: noActivity,
              signalMessageStart: noActivity,
              signalTextDelta: noActivity,
              signalReasoningDelta: noActivity,
              signalToolStart: noActivity,
            },
            blockReplyPipeline: null,
            blockStreamingEnabled: false,
            resolvedBlockStreamingBreak: "message_end",
            applyReplyToMode: (payload) => payload,
            shouldEmitToolResult: () => false,
            shouldEmitToolOutput: () => false,
            pendingToolTasks: new Set(),
            isHeartbeat: false,
            sessionKey,
            storePath: target.storePath,
            activeSessionStore: { [sessionKey]: entry },
            getActiveSessionEntry: () => entry,
            resolvedVerboseLevel: "off",
          };
          contextEngineLogicalTurnLease = await createContextEngineLogicalTurnLease({
            identity: { runId, sessionId: target.sessionId },
            config: cfg,
            agentDir,
            workspaceDir: state.workspaceDir,
          });
          const common: AgentFallbackCandidateCommonParams = {
            agentHarnessRuntimeOverride: undefined,
            assistantErrorTranscript: createAssistantErrorTranscript({ runId, config: cfg }),
            modelRoutingProvenance: {
              requestedProvider: "anthropic",
              requestedModel: "primary-fixture",
              stage: "fallback",
              fallbackReason: "timeout",
            },
            contextEngineLogicalTurnLease,
            onContextEngineTurnCandidate: () => {},
            preparedRunAdmission,
            turn,
            candidateRun: followupRun.run,
            runtimeConfig: cfg,
            provider: "google",
            model,
            runId,
            runLane: "test:chat-cli-account",
            candidateFastMode: {},
            suppressQueuedUserPersistenceForCandidate: false,
            userTurnTranscriptRecorder: undefined,
            notifyUserMessagePersisted: () => {},
            fastModeStartedAtMs: Date.now(),
            fastModeAutoProgressState: { offAnnounced: false, resetAnnounced: false },
            bootstrapContextRunKind: "default",
            bootstrapPromptWarningSignaturesSeen: [],
            currentTurnImages: { images: [] },
            signalExecutionPhaseForTyping: () => {},
            prepareAgentRunStart: () => {},
            notifyAgentRunStart: () => {},
            preserveProgressCallbackStartOrder: false,
            presentation: createAgentTurnPresentation({
              turn,
              replyMediaContext: { normalizePayload: async (p) => p },
              directBlockDeliveries: [],
              heartbeatState: { didLogStrip: false },
            }),
            timing: createAgentTurnTimingTracker(),
            onLifecycleBackstop: () => {},
            deferredLifecycle,
            isFallbackRetry: true,
            isFinalFallbackAttempt: true,
            classifyResult: (result) =>
              classifyEmbeddedAgentRunResultForModelFallback({ provider: "google", model, result }),
          };
          run = runCliFallbackCandidate({
            ...common,
            cliExecutionProvider: runtime,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            providerScopedAuthProfile: resolveRunAuthProfile(followupRun.run, "google", {
              config: cfg,
            }),
          });
        } else {
          const now = Date.now();
          const payload = {
            kind: "agentTurn",
            message: "Synthetic account-bound reply",
            thinking: "off",
            timeoutSeconds: 20,
          } satisfies Extract<CronStoredJob["payload"], { kind: "agentTurn" }>;
          const job: CronStoredJob = {
            id: "cron-cli-account-fixture",
            agentId: "main",
            name: "Owned cron account fixture",
            enabled: true,
            createdAtMs: now,
            updatedAtMs: now,
            schedule: { kind: "at", at: new Date(now + 60_000).toISOString() },
            sessionTarget: `session:${sessionKey}`,
            sessionKey,
            wakeMode: "now",
            payload,
            delivery: { mode: "none" },
            state: {},
            createdActor: { type: "system" },
          };
          const cancel = new AbortController();
          const input = {
            cfg,
            deps: createDefaultDeps(),
            job,
            deliveryAttemptFence: null,
            message: payload.message,
            sessionKey,
            agentId: "main",
            lane: "test:cron-cli-account",
            abortSignal: cancel.signal,
            admissionSource: "operator-schedule" as const,
            skillsSnapshot: { prompt: "", skills: [] },
          };
          const prepared = await prepareCronRunContext({
            input,
            isFastTestEnv: true,
            onLifecycleInterrupt: () => cancel.abort(new Error("Fixture interrupted")),
          });
          if (!prepared.ok) {
            throw new Error(JSON.stringify(prepared.result));
          }
          const ctx = prepared.context;
          const lease = ctx.preparedModelRuntimeLease;
          const contextOwner: { token?: string } = {};
          let active = true;
          closeCron = async () => {
            active = false;
            try {
              releaseAgentRunContext(runId, contextOwner.token);
              ctx.sessionWorkAdmission.release();
            } finally {
              try {
                await lease[Symbol.asyncDispose]();
              } finally {
                await ctx.workspaceLease?.release();
              }
            }
          };
          expect(ctx.runSessionKey).toBe(sessionKey);
          expect(ctx.usesDetachedRunSession).toBe(false);
          expect(ctx.cronSession.storePath).toBe(target.storePath);
          expect(ctx.liveSelection.authProfileId).toBe(CONFIGURED_PROFILE);
          const generation = getAgentEventLifecycleGeneration();
          const lifecycle = createAgentLifecycleTerminalBackstop({
            runId,
            sessionKey,
            getLifecycleGeneration: () => generation,
            resolveTerminationFields: () => (cancel.signal.aborted ? { aborted: true } : {}),
          });
          contextOwner.token = claimAgentRunContext(
            runId,
            {
              sessionKey: ctx.runSessionKey,
              sessionId: ctx.cronSession.sessionEntry.sessionId,
              agentId: ctx.agentId,
              lifecycleGeneration: generation,
              cronRunsByJobId: new Map([[job.id, { pacingEnabled: false }]]),
            },
            { trackOwner: true, ownsContext: true },
          );
          run = withPreparedModelRuntimePluginGenerationScope(
            lease.pluginGeneration,
            () =>
              withPluginRuntimeGenerationScope(lease.snapshot, () =>
                ctx.sessionWorkAdmission.run(() =>
                  withAgentRunLifecycleGeneration(generation, () =>
                    executeCronRun({
                      ...ctx,
                      cfg,
                      job,
                      runId,
                      lane: input.lane,
                      deliveryAttemptFence: null,
                      admissionSource: input.admissionSource,
                      agentVerboseDefault: ctx.agentCfg?.verboseDefault,
                      abortSignal: cancel.signal,
                      abortReason: () => "Fixture cancelled",
                      isAborted: () => cancel.signal.aborted,
                      lifecycle,
                      onPromptAdmission: (admission) => {
                        cronPromptAdmission?.close();
                        cronPromptAdmission = admission;
                      },
                      immutableThinkLevel: ctx.thinkingSelection.immutableThinkLevel,
                      thinkingCatalog: ctx.thinkingSelection.catalog,
                      loadThinkingCatalog: ctx.thinkingSelection.loadThinkingCatalog,
                      persistRunContinuationSession: ctx.runContinuationSession?.sync,
                      setRunContinuationCliExecutionProvider:
                        ctx.runContinuationSession?.setCliExecutionProvider,
                    }),
                  ),
                ),
              ),
            () => (active ? lease.snapshot : undefined),
          ).then((result) => {
            cronWinner = result.fallbackProvider;
            return result.runResult;
          });
        }
        void run.catch(() => {});
        // A real preparation refusal must stop this fixture instead of hanging.
        const gate = await Promise.race([
          entered.promise.then(() => ({ kind: "entered" as const })),
          run.then(
            (value) => ({ kind: "returned" as const, value }),
            (error: unknown) => ({ kind: "failed" as const, error }),
          ),
        ]);
        if (gate.kind === "failed") {
          throw gate.error;
        }
        expect(gate.kind, "candidate must reach the intended supported gate").toBe("entered");
        if (gate.kind !== "entered") {
          return;
        }
        if (stage === "before-execution") {
          expect(capturedAuthProfile).toBe(CLI_PROFILE);
        }
        const barrierEntry = await readSessionEntryInWorker(
          { ...target, readConsistency: "latest" },
          () => {},
        );
        expect(barrierEntry?.sessionId).toBe(entry.sessionId);
        if (pin) {
          await patchSessionEntryCore(target, (current) =>
            current
              ? {
                  ...current,
                  authProfileOverride: CONFIGURED_PROFILE,
                  authProfileOverrideSource: pin,
                  authProfileOverrideCompactionCount: undefined,
                }
              : null,
          );
          const persisted = await readSessionEntryInWorker(
            { ...target, readConsistency: "latest" },
            () => {},
          );
          expect(persisted).toMatchObject({
            sessionId: entry.sessionId,
            lifecycleRevision: barrierEntry?.lifecycleRevision,
            authProfileOverride: CONFIGURED_PROFILE,
            authProfileOverrideSource: pin,
          });
        }
        release.resolve();
        const outcome = await run.then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        const launches = await fs.readFile(receipt, "utf8").then(
          (value) => value.trim().split("\n").filter(Boolean),
          (error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return [];
            }
            throw error;
          },
        );
        if (pin) {
          const refusal = outcome.ok
            ? outcome.value.meta.error?.message
            : formatErrorMessage(outcome.error);
          expect
            .soft(refusal, "changed explicit pin must produce an account-intent refusal")
            .toMatch(/auth profile|account.*pin/i);
          expect
            .soft(launches, "same-revision pin change must prevent actual Node child launch")
            .toHaveLength(0);
        } else {
          if (!outcome.ok) {
            throw outcome.error;
          }
          expect(outcome.ok, "unchanged control must reach real prepared CLI").toBe(true);
          expect(launches).toHaveLength(1);
          if (kind === "cron") {
            expect(cronWinner).toBe("google");
          }
          expect(capturedAuthProfile).toBe(CLI_PROFILE);
          if (outcome.ok) {
            expect(outcome.value.payloads).toContainEqual(
              expect.objectContaining({ text: "Synthetic CLI reply." }),
            );
          }
        }
      } finally {
        release.resolve();
        await Promise.allSettled([run]);
        await cronPromptAdmission?.finish();
        await deferredLifecycle?.complete();
        preparedRunAdmission?.close();
        uninstallPlacement?.();
        await contextEngineLogicalTurnLease?.dispose();
        try {
          await closeCron?.();
        } finally {
          restoreActivePluginRegistrySnapshot(previousRegistry);
          try {
            await disposePluginRegistryInstances(builder.registry);
          } finally {
            fixtureBackends.delete(command);
          }
        }
        // withOpenClawTestState owns worker DB drain and directory cleanup after
        // the candidate and fixture plugin have released their actual resources.
      }
    });
  },
);
