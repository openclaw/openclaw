import assert from "node:assert/strict";
import path from "node:path";
import "../src/plugin-sdk/compiled-subprocess-testing.js";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { prepareCodexAttemptConnection } from "../extensions/codex/src/app-server/run-attempt-connection.js";
import { createSandboxContext } from "../extensions/codex/src/app-server/sandbox-exec-server.test-helpers.js";
import { createCodexAppServerBindingStore } from "../extensions/codex/src/app-server/session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "../extensions/codex/src/app-server/session-binding.sqlite.test-helpers.js";
import { createCodexRuntimePlanFixture } from "../extensions/codex/src/app-server/test-support.js";
import { runNativeTurn } from "../extensions/codex/src/app-server/thread-native.test-support.js";
import { createEmptyAgentDiscoveryStores } from "../src/agents/embedded-agent-runner/model.js";
import { prepareNativeCommandAuth } from "../src/agents/model-native-command-auth.js";
import { makeProviderModelFixture } from "../src/agents/test-helpers/provider-model-fixture.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { publishOperatorRoleConfigChange } from "../src/gateway/operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "../src/gateway/operator-run-authority.js";
import { createOperatorClient } from "../src/gateway/server-plugin-in-process-dispatch.test-support.js";
import type { EmbeddedRunAttemptParamsV2 } from "../src/plugin-sdk/agent-harness-runtime.js";
import { createAgentHarnessHostCapabilitiesForTest } from "../src/plugin-sdk/plugin-test-runtime.js";
import { resetPluginRuntimeStateForTest } from "../src/plugins/runtime.js";
import { setUserProfileRole } from "../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../src/state/user-profiles.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { createWorkerProof } from "./codex-worker-authority.test-support.js";

afterEach(() => resetPluginRuntimeStateForTest());

it.each([
  "allowed",
  "gateway-key",
  "gateway-profile",
  "placement-revoked",
  "model-revoked",
] as const)(
  "worker native-command production effect chain: %s",
  async (scenario) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const worker = await createWorkerProof(state, { onTestFinished });
      const bindingStore = createCodexAppServerBindingStore(
        createCodexSqliteTestBindingStateStore({
          namespace: "worker-proof-bindings",
          maxEntries: 10,
          env: state.env,
        }),
      );
      const model = makeProviderModelFixture({
        provider: "worker-proof",
        id: "codex-test-model",
        api: "openai-responses",
        baseUrl: "https://provider.invalid/v1",
      });
      const pluginConfig = {
        computerUse: { enabled: false },
        appServer: { workerHostedCloud: true },
      };
      let config: OpenClawConfig = {
        agents: { defaults: { model: "worker-proof/codex-test-model" } },
        tools: { exec: { security: "full", ask: "off" } },
        plugins: {
          entries: {
            codex: {
              config: { computerUse: { enabled: false }, appServer: { workerHostedCloud: true } },
            },
          },
        },
        models: {
          providers: {
            "worker-proof": {
              baseUrl: "https://provider.invalid/v1",
              api: "openai-responses",
              auth: "native-command",
              agentRuntime: { id: "codex" },
              models: [
                {
                  id: model.id,
                  name: model.id,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  maxTokens: 1000,
                },
              ],
            },
          },
        },
        gateway: {
          roles: {
            definitions: {
              proof: {
                agents: ["main"],
                scopes: ["operator.write"],
                sessions: { others: "none" },
                modelPolicy: { allow: ["worker-proof/codex-test-model"] },
              },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(config);
      const profile = ensureProfileForEmail("codex-authority@example.test");
      setUserProfileRole(profile.id, "proof");
      const authorityContext = { getRuntimeConfig: () => config };
      const captured = await captureGatewayOperatorRunAuthority({
        client: createOperatorClient({ profileId: profile.id, scopes: ["operator.write"] }),
        context: authorityContext,
      });
      assert(captured);
      const auth = prepareNativeCommandAuth({
        provider: model.provider,
        modelId: model.id,
        modelApi: model.api,
        modelBaseUrl: model.baseUrl,
        config,
        harnessId: "codex",
        harnessAuthBootstrap: "harness",
      });
      assert(auth);
      expect(auth.plan).toMatchObject({
        selectedAuthMode: "native-command",
      });
      expect(auth.plan.modelRoute).toBeUndefined();
      const attempt = {
        runId: "codex-worker-" + scenario,
        agentId: "main",
        sessionId: "worker-session",
        sessionKey: worker.sessionKey,
        sessionFile: path.join(state.sessionsDir(), scenario + ".jsonl"),
        workspaceDir: worker.workspaceDir,
        agentDir: state.agentDir(),
        prompt: "Reply with worker-authority-ok.",
        provider: model.provider,
        modelId: model.id,
        model,
        config,
        timeoutMs: 15_000,
        thinkLevel: "off" as const,
        ...createEmptyAgentDiscoveryStores(),
        authProfileStore: { version: 1 as const, profiles: {} },
      };
      const host = await createAgentHarnessHostCapabilitiesForTest({
        attempt,
        pluginId: "codex",
        nativeModelPolicySupport: "exact",
        operatorSource: captured.authority,
      });
      const sandbox = {
        ...createSandboxContext({}),
        sessionKey: worker.sessionKey,
        backendId: "node",
        ...worker.placement,
        containerWorkdir: worker.workspaceDir,
        placementExecutionMode: "remote-exec",
        workspaceDir: worker.workspaceDir,
      };
      const params: EmbeddedRunAttemptParamsV2 = {
        ...attempt,
        hostCapabilities: host.capabilities,
        runtimePlan: { ...createCodexRuntimePlanFixture(), auth: auth.plan },
        sandbox,
        permissionMode: "full",
        ...(scenario === "gateway-key"
          ? { resolvedApiKey: "synthetic-gateway-availability-key" }
          : {}),
        ...(scenario === "gateway-profile"
          ? { authProfileId: "worker-proof:gateway-profile" }
          : {}),
      };
      let connection: Awaited<ReturnType<typeof prepareCodexAttemptConnection>> | undefined;
      let client:
        | Awaited<ReturnType<NonNullable<typeof connection>["attemptClientFactory"]>>
        | undefined;
      try {
        if (scenario === "gateway-profile") {
          await expect(
            prepareCodexAttemptConnection({
              params,
              options: { runtime: worker.runtime, bindingStore, pluginConfig },
            }),
          ).rejects.toThrow("clear the Gateway auth profile");
          expect(worker.opens).toBe(0);
        } else {
          connection = await prepareCodexAttemptConnection({
            params,
            options: { runtime: worker.runtime, bindingStore, pluginConfig },
          });
          const opening = connection.attemptClientFactory({
            authProfileId: connection.startupClientAuthProfileId,
            preparedAuth: connection.startupPreparedAuth,
            authRequirement: connection.startupAuthRequirement,
            assertCurrent: connection.assertModelExecutionCurrent,
            // Preserve run-attempt-runtime's production cancellation binding.
            abandonSignal: connection.runAbortController.signal,
          });
          await Promise.race([worker.admitted, opening]);
          expect(await worker.commandCount()).toBe(0);
          if (scenario === "placement-revoked") {
            worker.revokePlacement();
          } else if (scenario === "model-revoked") {
            config = {
              ...config,
              gateway: {
                roles: {
                  definitions: {
                    proof: {
                      agents: ["main"],
                      scopes: ["operator.write"],
                      sessions: { others: "none" },
                      modelPolicy: { deny: ["worker-proof/codex-test-model"] },
                    },
                  },
                },
              },
            };
            setRuntimeConfigSnapshot(config);
            publishOperatorRoleConfigChange(authorityContext);
            expect(captured.authority.signal?.aborted).not.toBe(true);
          }
          worker.continueAdmission();
          if (scenario === "placement-revoked" || scenario === "model-revoked") {
            const error = await opening.then(
              (opened) => {
                client = opened;
                return undefined;
              },
              (reason: unknown) => reason,
            );
            expect(await worker.commandCount()).toBe(0);
            expect(error).toBeInstanceOf(Error);
            if (scenario === "model-revoked") {
              expect(connection.assertModelExecutionCurrent).toThrow(
                "operator role cannot use this model",
              );
            }
          } else {
            client = await opening;
            expect(worker.requests).toEqual([]);
            const thread = await client.request(
              "thread/start",
              {
                model: model.id,
                cwd: worker.workspaceDir,
                approvalPolicy: "never",
                sandbox: "workspace-write",
                experimentalRawEvents: false,
                persistExtendedHistory: false,
              },
              { assertCurrent: connection.assertModelExecutionCurrent, timeoutMs: 10_000 },
            );
            assert(
              thread &&
                typeof thread === "object" &&
                "thread" in thread &&
                thread.thread &&
                typeof thread.thread === "object" &&
                "id" in thread.thread &&
                typeof thread.thread.id === "string",
            );
            await expect(
              runNativeTurn(client, thread.thread.id, "Reply with worker-authority-ok.", {
                timeoutMs: 10_000,
                completionTimeoutMs: 10_000,
              }),
            ).resolves.toMatchObject({ status: "completed" });
            expect(worker.requests).toEqual([
              { authorization: "Bearer synthetic-worker-bearer", model: model.id },
            ]);
            expect(await worker.commandCount()).toBeGreaterThan(0);
          }
        }
      } finally {
        await client?.closeAndWait();
        connection?.cancellation.dispose();
        connection?.releaseModelExecution();
        connection?.releaseBindingAuthority();
        host.close();
        captured.release();
        await worker.close();
      }
      if (scenario !== "allowed" && scenario !== "gateway-key") {
        expect(await worker.commandCount()).toBe(0);
        expect(worker.requests).toEqual([]);
        if (scenario === "placement-revoked") {
          expect(worker.failure).toContain("workspace lease is released");
        }
      }
    }),
  45_000,
);
