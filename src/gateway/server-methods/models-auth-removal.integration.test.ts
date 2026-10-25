import { withTimeout } from "@openclaw/fs-safe/advanced";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { upsertAuthProfile } from "../../agents/auth-profiles.js";
import type { AgentCommandGatewayIngressOpts } from "../../agents/command/types.js";
import { registerConfigCli } from "../../cli/config-cli.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import * as configLock from "../../config/write-lock.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createModelsTestState,
  settleModelsWork,
  startModelsGateway,
} from "./models-integration.test-support.js";

function configuredProvider(apiKey: string, name = "Fixture") {
  return {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    apiKey,
    models: [{ id: "fixture-model", name }],
  };
}

const inference = vi.hoisted(() => ({ run: vi.fn() }));
// mock-isolation: Only inference is replaced; Gateway admission, source identity, and credentials remain real.
vi.mock("../../commands/agent.js", () => ({
  agentCommand: inference.run,
  agentCommandFromGatewayIngress: inference.run,
  agentCommandFromIngress: inference.run,
}));

describe("models.authLogout with a concurrent registered config set", () => {
  it.each([
    {
      name: "preserves a replacement key and refuses stale removal",
      replacement: "synthetic-inline-B",
    },
    {
      name: "removes the selected key after an unrelated provider changes",
      updatedProvider: "other-fixture",
      replacement: "synthetic-unrelated-B",
      conflict: false,
    },
    {
      name: "preserves a replacement secret reference and refuses stale removal",
      replacement: { source: "env", provider: "default", id: "INLINE_REMOVAL_TEST_KEY" },
    },
    {
      name: "preserves a replacement env reference with the same resolved key",
      replacement: "${INLINE_REMOVAL_SAME_KEY}",
      selectedKey: "synthetic-inline-A",
    },
    {
      name: "publishes removal before returning when config reload is enabled",
      updatedProvider: "other-fixture",
      replacement: "synthetic-unrelated-B",
      conflict: false,
      reloadMode: "hybrid" as const,
    },
  ])(
    "$name",
    async ({
      updatedProvider = "fixture",
      replacement,
      selectedKey = replacement,
      conflict = true,
      reloadMode = "off",
    }) => {
      await using state = await createModelsTestState("models-auth-removal", {
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
          INLINE_REMOVAL_TEST_KEY: "synthetic-secret-B",
          INLINE_REMOVAL_SAME_KEY: "synthetic-inline-A",
        },
      });
      const token = "inline-removal-gateway-token";
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: {
            main: { workspace: state.workspaceDir },
            writer: { workspace: state.workspaceDir },
          },
          defaults: { model: "fixture/fixture-model" },
        },
        plugins: { enabled: false },
        gateway: { mode: "local", auth: { mode: "token", token }, reload: { mode: reloadMode } },
        models: {
          providers: {
            fixture: configuredProvider("synthetic-inline-A"),
            FIXTURE: configuredProvider("${INLINE_REMOVAL_TEST_KEY}"),
            "other-fixture": configuredProvider("synthetic-unrelated-A", "Other fixture"),
          },
        },
      };
      const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
      await using gateway = await startModelsGateway(state, cfg, token, { hotReloadRecovery });
      const { client } = gateway;
      const logoutProvider = (selection: Record<string, unknown> = {}) =>
        client.request("models.authLogout", { provider: "fixture", agentId: "main", ...selection });
      const saveKey = () =>
        client.request<{ profileId: string }>("models.authSetApiKey", {
          provider: "fixture",
          apiKey: "synthetic-held-run-key",
          agentId: "main",
        });
      const acquired = createDeferredCore();
      const save = createDeferredCore();
      const attempted = createDeferredCore();
      let performSave = false;
      let writer: Promise<void> | undefined;
      let logout: Promise<unknown> | undefined;
      try {
        await gateway.server.startupSettled;
        vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
          throw new Error(`Registered config command exited with ${code}`);
        });
        const withConfigWriteLock = configLock.withConfigWriteLock;
        writer = withConfigWriteLock(state.configPath, async () => {
          acquired.resolve();
          await save.promise;
          if (!performSave) {
            return;
          }
          const program = new Command().exitOverride();
          registerConfigCli(program);
          await program.parseAsync(
            [
              "config",
              "set",
              `models.providers.${updatedProvider}.apiKey`,
              JSON.stringify(replacement),
              "--strict-json",
            ],
            { from: "user" },
          );
        });
        await withTimeout(acquired.promise, 10_000, "fixture config lock");
        const observation = vi
          .spyOn(configLock, "withConfigWriteLock")
          .mockImplementation(
            async <T>(...args: Parameters<typeof withConfigWriteLock<T>>): Promise<T> => {
              if (args[0] === state.configPath) {
                attempted.resolve();
              }
              return await withConfigWriteLock<T>(...args);
            },
          );
        // Observe scheduling only; both registered commands retain the real write owners.
        logout = settleModelsWork(logoutProvider({ credentialType: "api_key" }));
        await withTimeout(attempted.promise, 10_000, "pending removal config lock");
        observation.mockRestore();
        performSave = true;
        save.resolve();
        await writer;
        const outcome = await logout;
        expect(outcome).toMatchObject(
          conflict
            ? {
                error: {
                  message: expect.stringContaining(
                    "Nothing was removed. Reload Models and retry removal.",
                  ),
                },
              }
            : { error: undefined, result: { removedProfiles: [] } },
        );
        const settled = await readConfigFileSnapshot();
        if (!conflict) {
          if (reloadMode === "off") {
            expect(outcome).toMatchObject({
              result: { warning: expect.stringContaining("gateway restart") },
            });
          } else {
            expect(outcome, JSON.stringify(outcome)).not.toMatchObject({
              result: { warning: expect.any(String) },
            });
            await expect(
              client.request("models.authStatus", { agentId: "main" }),
            ).resolves.toMatchObject({
              providers: expect.not.arrayContaining([
                expect.objectContaining({
                  provider: "fixture",
                  apiKey: expect.objectContaining({ source: "config" }),
                }),
              ]),
            });
          }
        }
        expect(settled.parsed).toMatchObject({
          models: {
            providers: {
              FIXTURE: { apiKey: "${INLINE_REMOVAL_TEST_KEY}" },
              ...(conflict ? { fixture: { apiKey: replacement } } : {}),
            },
          },
        });
        expect(settled.sourceConfig.models?.providers?.fixture?.apiKey).toEqual(
          conflict ? selectedKey : undefined,
        );
        expect(settled.sourceConfig.models?.providers?.["other-fixture"]?.apiKey).toBe(
          conflict ? "synthetic-unrelated-A" : "synthetic-unrelated-B",
        );
        expect(hotReloadRecovery).not.toHaveBeenCalled();
        if (reloadMode === "hybrid") {
          const turns = new Map(
            ["fixture", "other-fixture", "writer", "external"].map((runId) => [
              runId,
              {
                entered: createDeferredCore(),
                release: createDeferredCore(),
                cancelled: createDeferredCore(),
                signal: undefined as AbortSignal | undefined,
              },
            ]),
          );
          inference.run.mockImplementation(async (options) => {
            const command = options as AgentCommandGatewayIngressOpts;
            const turn = turns.get(command.runId!);
            if (!turn) {
              throw new Error("Unexpected auth boundary inference");
            }
            turn.signal = command.abortSignal;
            command.abortSignal?.addEventListener("abort", () => turn.cancelled.resolve(), {
              once: true,
            });
            turn.entered.resolve();
            await turn.release.promise;
          });
          const startTurn = async (runId: string) => {
            const agentId = runId === "writer" ? "writer" : "main";
            await client.request("agent", {
              agentId,
              sessionKey: `agent:${agentId}:dashboard:auth-${runId}`,
              message: "Hold inference through credential removal",
              provider: runId === "other-fixture" ? runId : "fixture",
              model: "fixture-model",
              idempotencyKey: runId,
            });
            await turns.get(runId)!.entered.promise;
          };
          const expectLogout = (selection: Record<string, unknown>, removedProfiles: unknown) =>
            expect(logoutProvider(selection)).resolves.toMatchObject({
              removedProfiles,
              abortedRunIds: [],
            });
          try {
            for (const runId of ["fixture", "other-fixture", "writer"]) {
              await startTurn(runId);
            }
            const saved = await saveKey();
            await expectLogout({ profileIds: [saved.profileId] }, [saved.profileId]);
            expect(turns.get("fixture")!.signal?.aborted).toBe(false);
            await saveKey();
            upsertAuthProfile({
              agentDir: resolveAgentDir({ agents: cfg.agents }, "main"),
              profileId: "fixture:ref",
              credential: {
                provider: "fixture",
                type: "api_key",
                keyRef: { source: "env", provider: "default", id: "INLINE_REMOVAL_TEST_KEY" },
              },
            });
            await expectLogout({ credentialType: "api_key" }, [saved.profileId]);
            expect(turns.get("fixture")!.signal?.aborted).toBe(false);
            await saveKey();
            await expect(logoutProvider()).resolves.toMatchObject({
              removedProfiles: expect.arrayContaining([saved.profileId, "fixture:ref"]),
              abortedRunIds: ["fixture"],
            });
            await turns.get("fixture")!.cancelled.promise;
            expect(turns.get("other-fixture")!.signal?.aborted).toBe(false);
            expect(turns.get("writer")!.signal?.aborted).toBe(false);
            // The remaining config-owned reference is enough for admission;
            // full logout must revoke inference even with no saved profiles.
            await startTurn("external");
            await expect(logoutProvider()).resolves.toMatchObject({
              removedProfiles: [],
              abortedRunIds: ["external"],
            });
            await turns.get("external")!.cancelled.promise;
            expect(turns.get("writer")!.signal?.aborted).toBe(false);
          } finally {
            for (const turn of turns.values()) {
              turn.release.resolve();
            }
            inference.run.mockReset();
          }
        }
      } finally {
        save.resolve();
        await writer?.catch(() => undefined);
        await logout?.catch(() => undefined);
        vi.restoreAllMocks();
      }
    },
  );
});
