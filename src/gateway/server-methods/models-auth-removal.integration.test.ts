import { withTimeout } from "@openclaw/fs-safe/advanced";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
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

function configuredProvider(apiKey: string, models: { id: string; name: string }[] = []) {
  return { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey, models };
}

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
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
        gateway: { mode: "local", auth: { mode: "token", token }, reload: { mode: reloadMode } },
        models: {
          providers: {
            fixture: configuredProvider("synthetic-inline-A"),
            FIXTURE: configuredProvider("${INLINE_REMOVAL_TEST_KEY}", [
              { id: "fixture-model", name: "Fixture" },
            ]),
            "other-fixture": configuredProvider("synthetic-unrelated-A"),
          },
        },
      };
      const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
      await using gateway = await startModelsGateway(state, cfg, token, { hotReloadRecovery });
      const { client } = gateway;
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
          const committed = await readConfigFileSnapshot();
          expect(committed.parsed).toMatchObject({
            models: { providers: { [updatedProvider]: { apiKey: replacement } } },
          });
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
        logout = settleModelsWork(
          client.request("models.authLogout", {
            provider: "fixture",
            agentId: "main",
            credentialType: "api_key",
          }),
        );
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
      } finally {
        save.resolve();
        await writer?.catch(() => undefined);
        await logout?.catch(() => undefined);
        vi.restoreAllMocks();
      }
    },
  );
});
