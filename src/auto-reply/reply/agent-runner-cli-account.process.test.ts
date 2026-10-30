import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { bindSessionMcpRuntimeTestScheduler } from "../../agents/agent-bundle-mcp-manager.test-support.js";
import { retireSessionMcpRuntime } from "../../agents/agent-bundle-mcp-tools.js";
import { FailoverError } from "../../agents/failover/error.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  replaceSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { admitScheduledOccurrence } from "../../cron/execution-context-admission.js";
import { runCronIsolatedAgentTurn } from "../../cron/isolated-agent.js";
import type { CronStoredJob } from "../../cron/types.js";
import { onAgentEvent } from "../../infra/agent-events.js";
import { formatErrorMessage, hasErrnoCode } from "../../infra/errors.js";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import { loadAndActivateRootPluginRegistry } from "../../plugins/loader.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  disposePluginRegistryInstances,
} from "../../plugins/runtime.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withFullRuntimeReplyConfig } from "./get-reply-fast-path.js";
import { getReplyFromConfig } from "./get-reply.js";

const SELF_FIXTURE_CLI_SOURCE = fileURLToPath(
  new URL("../../../test/fixtures/chat-cli-account/cli.mjs", import.meta.url),
);

const CONFIGURED_PROFILE = "anthropic:configured-fixture";
const CLI_PROFILE = "google:cli-fixture";
const OTHER_CLI_PROFILE = "google:other-fixture";
const NATIVE_PROFILE = "anthropic:claude-cli";
const model = "fixture-model";
const fixtureBackends = resolveGlobalMap<string, CliBackendPlugin[]>(
  Symbol.for("openclaw.test.cliAccountFixtureBackends"),
);

// Full entry points cover admission and late pin edits that selector-only mocks miss.
// The CLI is an owned Node fixture; scheduled runs retain their recorded-account gate.
it.for([
  { kind: "chat", stage: "placement", pin: null, accountScope: "cross-provider" },
  { kind: "chat", stage: "placement", pin: "user", accountScope: "cross-provider" },
  { kind: "chat", stage: "placement", pin: "user-link", accountScope: "cross-provider" },
  { kind: "chat", stage: "before-execution", pin: null, accountScope: "cross-provider" },
  { kind: "chat", stage: "before-execution", pin: "user", accountScope: "cross-provider" },
  { kind: "chat", stage: "before-execution", pin: "user-link", accountScope: "cross-provider" },
  { kind: "cron-event", stage: "before-execution", pin: null, accountScope: "cross-provider" },
  {
    kind: "cron-event",
    stage: "before-execution",
    pin: "user-link",
    accountScope: "cross-provider",
  },
  { kind: "scheduled-cron", stage: "account-admission", pin: null, accountScope: "cross-provider" },
  { kind: "chat", stage: "placement", pin: "user", accountScope: "same-provider" },
  { kind: "chat", stage: "placement", pin: "user-link", accountScope: "same-provider" },
  { kind: "chat", stage: "placement", pin: "user", accountScope: "selected-profile" },
  { kind: "chat", stage: "before-execution", pin: null, accountScope: "native-user" },
  { kind: "chat", stage: "before-execution", pin: null, accountScope: "native-user-link" },
  { kind: "chat", stage: "before-execution", pin: "user-link", accountScope: "native-user" },
  { kind: "cron-event", stage: "before-execution", pin: null, accountScope: "native-user" },
] as const)(
  "protects $kind $pin intent at $stage ($accountScope) before actual CLI launch",
  async ({ kind, stage, pin, accountScope }, { signal }) => {
    const nativeLogin = accountScope === "native-user" || accountScope === "native-user-link";
    const runtime = nativeLogin ? "claude-cli" : "google-gemini-cli";
    const destinationProvider = nativeLogin ? "anthropic" : "google";
    const configuredProvider =
      nativeLogin || accountScope === "cross-provider" ? "anthropic" : "google";
    const configuredModel = configuredProvider === "anthropic" ? "primary-fixture" : model;
    const configuredProfile = nativeLogin
      ? NATIVE_PROFILE
      : accountScope === "cross-provider"
        ? CONFIGURED_PROFILE
        : CLI_PROFILE;
    const replacementPin =
      nativeLogin || accountScope === "cross-provider"
        ? CONFIGURED_PROFILE
        : accountScope === "same-provider"
          ? OTHER_CLI_PROFILE
          : CLI_PROFILE;
    await withOpenClawTestState({ label: "chat-cli-account-process" }, async (state) => {
      const previousRegistry = captureActivePluginRegistrySnapshot();
      const entered = createDeferred();
      const release = createDeferred();
      const packageRoot = path.join(state.root, "self-cli-package");
      const command = path.join(packageRoot, "cli.mjs");
      const receipt = path.join(state.root, "cli-launches.jsonl");
      const readLaunches = () =>
        fs.readFile(receipt, "utf8").then(
          (value) => value.trim().split("\n").filter(Boolean),
          (error: unknown) => {
            if (hasErrnoCode(error, "ENOENT")) {
              return [];
            }
            throw error;
          },
        );
      await fs.mkdir(packageRoot);
      const cliSource = await fs.readFile(SELF_FIXTURE_CLI_SOURCE, "utf8");
      await fs.writeFile(
        command,
        `#!${process.execPath}\n` + cliSource.replace(/^#![^\n]*\n/, ""),
        {
          mode: 0o755,
        },
      );
      for (const name of ["package.json", "openclaw.plugin.json", "plugin.cjs"]) {
        await fs.copyFile(
          fileURLToPath(
            new URL(`../../../test/fixtures/chat-cli-account/${name}`, import.meta.url),
          ),
          path.join(packageRoot, name),
        );
      }
      const cfg = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: {
              primary: `${configuredProvider}/${configuredModel}@${configuredProfile}`,
              fallbacks: [`${destinationProvider}/${model}`],
            },
            models: {
              "anthropic/primary-fixture": { agentRuntime: { id: "claude-cli" } },
              [`${destinationProvider}/${model}`]: { agentRuntime: { id: runtime } },
            },
          },
        },
        models: {
          catalogRefresh: { enabled: false },
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
                models: (nativeLogin && provider === "anthropic" ? [id, model] : [id]).map(
                  (modelId) => ({
                    id: modelId,
                    name: modelId,
                    reasoning: false,
                    input: ["text" as const],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 1024,
                  }),
                ),
              },
            ]),
          ),
        },
        plugins: {
          allow: ["chat-cli-account-fixture"],
          load: { paths: [packageRoot] },
          entries: {
            "chat-cli-account-fixture": { enabled: true, config: { fixtureKey: command } },
          },
        },
        auth: {
          profiles: {
            [CONFIGURED_PROFILE]: { provider: "anthropic", mode: "api_key" as const },
            [CLI_PROFILE]: { provider: "google", mode: "api_key" as const },
            [OTHER_CLI_PROFILE]: { provider: "google", mode: "api_key" as const },
            ...(nativeLogin
              ? { [NATIVE_PROFILE]: { provider: "claude-cli", mode: "token" as const } }
              : {}),
          },
          order: { google: [CLI_PROFILE], anthropic: [CONFIGURED_PROFILE] },
        },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [CONFIGURED_PROFILE]: {
            type: "api_key",
            provider: "anthropic",
            key: "synthetic-anthropic-key",
          },
          [CLI_PROFILE]: { type: "api_key", provider: "google", key: "synthetic-google-key" },
          [OTHER_CLI_PROFILE]: {
            type: "api_key",
            provider: "google",
            key: "synthetic-other-key",
          },
          ...(nativeLogin
            ? {
                [NATIVE_PROFILE]: {
                  type: "token" as const,
                  provider: "claude-cli",
                  token: "synthetic-native-token",
                },
              }
            : {}),
        },
      });
      const sessionKey = `agent:main:chat-cli-account:${path.basename(state.root).toLowerCase()}`;
      const target = {
        agentId: "main",
        sessionId: `cli-account-${path.basename(state.root).toLowerCase()}`,
        sessionKey,
        storePath: path.join(state.sessionsDir("main"), "sessions.json"),
      };
      const entry = {
        sessionId: target.sessionId,
        lifecycleRevision: randomUUID(),
        updatedAt: Date.now(),
        ...(nativeLogin
          ? {
              authProfileOverride: NATIVE_PROFILE,
              authProfileOverrideSource:
                accountScope === "native-user-link" ? ("user-link" as const) : ("user" as const),
            }
          : {}),
      };
      await replaceSessionEntry(target, entry);
      let terminalError: string | undefined;
      const unsubscribe = onAgentEvent((event) => {
        if (
          event.sessionKey === sessionKey &&
          event.stream === "lifecycle" &&
          event.data.phase === "error" &&
          event.data.executionSettled === true &&
          typeof event.data.error === "string"
        ) {
          terminalError = event.data.error;
        }
      });
      let uninstallPlacement: (() => void) | undefined;
      let registry: Awaited<ReturnType<typeof loadAndActivateRootPluginRegistry>> | undefined;
      let run: Promise<{ text: string; error?: string }> | undefined;
      let cronOccurrence: Awaited<ReturnType<typeof admitScheduledOccurrence>> | undefined;
      try {
        let capturedAuthProfile: string | undefined;
        const preparedCliBackends: string[] = [];
        const destination: CliBackendPlugin = {
          id: runtime,
          modelProvider: destinationProvider,
          autoSelectAuthProfile: nativeLogin ? false : undefined,
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
            preparedCliBackends.push(runtime);
            if (nativeLogin && context.modelId === "primary-fixture") {
              expect(context.authProfileId).toBeUndefined();
              throw new FailoverError("Synthetic primary billing refusal", {
                reason: "billing",
                provider: "anthropic",
                model: "primary-fixture",
              });
            }
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
        const primary: CliBackendPlugin = {
          ...destination,
          id: "claude-cli",
          modelProvider: "anthropic",
          prepareExecution: (context) => {
            preparedCliBackends.push("claude-cli");
            expect(context.authProfileId).toBe(CONFIGURED_PROFILE);
            throw new FailoverError("Synthetic primary billing refusal", {
              reason: "billing",
              provider: "anthropic",
              model: "primary-fixture",
            });
          },
        };
        fixtureBackends.set(command, nativeLogin ? [destination] : [destination, primary]);
        await bindSessionMcpRuntimeTestScheduler();
        registry = await loadAndActivateRootPluginRegistry({
          config: cfg,
          workspaceDir: state.workspaceDir,
        });
        if (stage === "placement") {
          uninstallPlacement = installSessionPlacementAdmissionProvider({
            assertCompactionSuccessorAllowed: () => {},
            executeLocalTurn: async (_claim, runLocal, assertCurrent) => {
              // Let the synthetic primary fail; pause at the destination's placement.
              if (configuredModel === "primary-fixture" && preparedCliBackends.length === 0) {
                return runLocal();
              }
              entered.resolve();
              await release.promise;
              assertCurrent?.();
              return runLocal();
            },
            executeTurn: async (_claim, _params, runLocal) => runLocal(),
          });
        }
        if (kind === "chat") {
          const message = "Synthetic account-bound reply";
          run = getReplyFromConfig(
            {
              Body: message,
              BodyForAgent: message,
              SessionKey: sessionKey,
              From: "webchat",
              To: "webchat",
              Provider: "webchat",
              Surface: "webchat",
              ChatType: "direct",
              MessageSid: "account-proof-user",
              CommandAuthorized: true,
            },
            { disableTools: true, abortSignal: signal },
            withFullRuntimeReplyConfig(cfg),
          ).then((reply) => {
            const payloads = [reply].flat().filter((payload) => payload != null);
            const text = payloads.map((payload) => payload.text ?? "").join("\n");
            return {
              text,
              error: payloads.some((payload) => payload.isError)
                ? text || "Chat returned an error reply"
                : undefined,
            };
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
            id: `cron-cli-account-${path.basename(state.root).toLowerCase()}`,
            agentId: "main",
            name:
              kind === "cron-event" ? "Owned immediate event fixture" : "Owned scheduled fixture",
            enabled: true,
            createdAtMs: now,
            updatedAtMs: now,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: `session:${sessionKey}`,
            sessionKey,
            wakeMode: "now",
            payload,
            delivery: { mode: "none" },
            state: {},
            createdActor: { type: "system" },
          };
          cronOccurrence = await admitScheduledOccurrence({
            cfg,
            job,
            agentId: "main",
            trigger: kind === "cron-event" ? "event" : "cron",
          });
          run = runCronIsolatedAgentTurn({
            abortSignal: signal,
            occurrence: cronOccurrence,
            cfg,
            deps: {},
            job,
            trigger: kind === "cron-event" ? "event" : "cron",
            deliveryAttemptFence: null,
            message: payload.message,
            sessionKey,
            agentId: "main",
            lane: "test:cron-cli-account",
            admissionSource: kind === "scheduled-cron" ? "operator-schedule" : undefined,
          }).then((result) => ({
            text: result.outputText ?? result.summary ?? "",
            error: result.error ?? (result.status === "ok" ? undefined : result.status),
          }));
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
        if (kind === "scheduled-cron") {
          expect(gate.kind, "scheduled account refusal must precede CLI preparation").toBe(
            "returned",
          );
          if (gate.kind !== "returned") {
            throw new Error("Missing scheduled refusal result");
          }
          expect(gate.value.error).toContain("Automation has no recorded inference account");
          expect(preparedCliBackends).toEqual([]);
          expect(await readLaunches()).toHaveLength(0);
          return;
        }
        if (gate.kind === "failed") {
          throw gate.error;
        }
        expect(gate.kind, "candidate must reach the intended supported gate").toBe("entered");
        if (stage === "before-execution") {
          expect(capturedAuthProfile).toBe(nativeLogin ? undefined : CLI_PROFILE);
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
                  authProfileOverride: replacementPin,
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
            authProfileOverride: replacementPin,
            authProfileOverrideSource: pin,
          });
        }
        release.resolve();
        const outcome = await run.catch((error: unknown) => ({
          text: "",
          error: formatErrorMessage(error),
        }));
        const launches = await readLaunches();
        if (pin && accountScope !== "selected-profile") {
          expect(outcome.error, "public owner must record a failed reply").toBeDefined();
          const refusal = kind === "chat" ? terminalError : outcome.error;
          expect
            .soft(refusal, "changed explicit pin must produce an account-intent refusal")
            .toMatch(/auth profile|account.*pin/i);
          expect
            .soft(launches, "same-revision pin change must prevent actual Node child launch")
            .toHaveLength(0);
        } else {
          expect(launches).toHaveLength(1);
          if (kind === "cron-event") {
            expect(preparedCliBackends).toEqual(["claude-cli", runtime]);
          }
          expect(capturedAuthProfile).toBe(nativeLogin ? undefined : CLI_PROFILE);
          expect(outcome.error).toBeUndefined();
          expect(outcome.text).toContain("Synthetic CLI reply.");
        }
      } finally {
        release.resolve();
        await Promise.allSettled([run]);
        unsubscribe();
        await retireSessionMcpRuntime({
          sessionId: target.sessionId,
          reason: "cli-account-process-fixture",
        });
        cronOccurrence?.release();
        uninstallPlacement?.();
        restoreActivePluginRegistrySnapshot(previousRegistry);
        try {
          if (registry) {
            await disposePluginRegistryInstances(registry);
          }
        } finally {
          fixtureBackends.delete(command);
        }
        // The state fixture drains DB workers after the public calls and plugin teardown.
      }
    });
  },
);
