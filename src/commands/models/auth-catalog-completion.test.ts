// Real credential owners and catalog locks; only user/provider and Gateway boundaries are fixtures.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { upsertAuthProfileWithLockOrThrow } from "../../agents/auth-profiles/profiles.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store-runtime.js";
import { withModelsTempHome } from "../../agents/models-config.e2e-harness.js";
import { readPersistedPluginModelCatalogGeneration } from "../../agents/plugin-model-catalog-logout.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { summarizeMigrationItems } from "../../plugin-sdk/migration.js";
import type { MigrationPlan, ProviderPlugin } from "../../plugins/types.js";
import { createTestWizardPrompter } from "../../test-utils/plugin-setup-wizard.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";
import { modelsAuthLogoutCommand } from "./auth-logout.js";
import {
  modelsAuthPasteApiKeyCommand,
  modelsAuthPasteTokenCommand,
  modelsAuthSetupTokenCommand,
  runModelsAuthLoginFlowCore,
} from "./auth.js";

const boundary = vi.hoisted(() => ({
  providers: [] as ProviderPlugin[],
  plan: vi.fn(),
  apply: vi.fn(),
  password: vi.fn(),
  afterPromotion: undefined as (() => Promise<void>) | undefined,
  refresh: vi.fn(),
}));
vi.mock("../../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: () => boundary.providers,
}));
vi.mock("../../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: () => undefined,
  resolvePluginSetupRegistry: () => ({ providers: [] }),
}));
vi.mock("../../plugins/migration-provider-runtime.js", () => ({
  withPluginMigrationProviders: async (_params: unknown, run: (providers: unknown[]) => unknown) =>
    await run([{ id: "fixture", label: "Fixture", plan: boundary.plan, apply: boundary.apply }]),
}));
vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  confirm: vi.fn(async () => true),
  isCancel: () => false,
  password: boundary.password,
  select: vi.fn(),
  text: vi.fn(),
}));
vi.mock("./auth-refresh.js", () => ({ refreshRunningGatewayAuthState: boundary.refresh }));
vi.mock("../../agents/auth-profiles/profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles/profiles.js")>();
  return {
    ...actual,
    promoteAuthProfileInOrder: async (
      ...args: Parameters<typeof actual.promoteAuthProfileInOrder>
    ) => {
      const result = await actual.promoteAuthProfileInOrder(...args);
      await boundary.afterPromotion?.();
      return result;
    },
  };
});

const provider = "fixture";
const profileId = "fixture:saved";
const credential = { type: "token" as const, provider, token: "synthetic-auth-token" };
const plan: MigrationPlan = {
  providerId: provider,
  source: "/synthetic-source",
  items: [
    {
      id: "auth:token",
      kind: "auth",
      action: "create",
      status: "planned",
      details: { provider, profileId, credentialKind: "token" },
    },
  ],
  summary: summarizeMigrationItems([]),
};

function configureProvider(
  imported = false,
  run: ProviderPlugin["auth"][number]["run"] = vi.fn(async () => ({
    profiles: [{ profileId, credential }],
  })),
) {
  boundary.providers = [
    {
      id: provider,
      label: "Fixture",
      auth: [
        {
          id: "token",
          label: "Token",
          kind: "token",
          run,
          ...(imported
            ? {
                credentialImport: {
                  migrationProviderId: provider,
                  itemId: "auth:token",
                  credentialKind: "token" as const,
                },
              }
            : {}),
        },
      ],
    },
  ];
  return run;
}

async function withFixture(
  run: (fixture: {
    cfg: OpenClawConfig;
    agentDir: string;
    runtime: ReturnType<typeof createTestRuntime>;
    logout: () => Promise<void>;
    login: (imported?: boolean) => ReturnType<typeof runModelsAuthLoginFlowCore>;
  }) => Promise<void>,
  agent = "owner",
) {
  await withModelsTempHome(async (home) => {
    const stateDir = path.join(home, ".openclaw");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }, { id: "owner" }] },
    };
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify(cfg));
    setRuntimeConfigSnapshot(cfg, cfg);
    const agentDir = path.join(stateDir, "agents", agent, "agent");
    const runtime = createTestRuntime();
    boundary.plan.mockResolvedValue(plan);
    boundary.apply.mockImplementation(async () => {
      await updateAuthProfileStoreWithLock({
        agentDir,
        updater: (store) => {
          store.profiles[profileId] = credential;
          return true;
        },
      });
      return { ...plan, items: plan.items.map((item) => ({ ...item, status: "migrated" })) };
    });
    boundary.password.mockResolvedValue(credential.token);
    const logout = () => modelsAuthLogoutCommand({ profileId, agent, yes: true }, runtime);
    const login = (imported = false) => {
      configureProvider(imported);
      return runModelsAuthLoginFlowCore({
        provider,
        agent,
        config: cfg,
        runtime,
        prompter: createTestWizardPrompter(),
      });
    };
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    try {
      await run({ cfg, agentDir, runtime, logout, login });
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
    }
  });
}

afterEach(() => {
  boundary.afterPromotion = undefined;
  boundary.providers = [];
  vi.resetAllMocks();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

describe("models auth catalog admission and completion", () => {
  it.each([false, true])(
    "completes fresh sign-in without changing catalog generations (import=%s)",
    async (imported) => {
      await withFixture(async ({ cfg, agentDir, login }) => {
        cfg.auth = { order: { fixture: ["fixture:older"] } };
        await upsertAuthProfileWithLockOrThrow({
          agentDir,
          profileId: "fixture:older",
          credential: { ...credential, token: "synthetic-older" },
        });
        const generation = readPersistedPluginModelCatalogGeneration(agentDir);
        await expect(login(imported)).resolves.toMatchObject({
          profiles: [{ profileId, provider, mode: "token" }],
          ...(imported ? { imported: true } : {}),
        });
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toEqual(credential);
        expect(loadPersistedAuthProfileStore(agentDir)?.order?.fixture).toEqual([
          profileId,
          "fixture:older",
        ]);
        expect(readPersistedPluginModelCatalogGeneration(agentDir)).toBe(generation);
      });
    },
  );

  it.each(["login", "setup-token", "paste-token", "paste-api-key"])(
    "refuses delayed %s after logout before persistence",
    async (route) => {
      await withFixture(async ({ cfg, agentDir, runtime, logout }) => {
        await upsertAuthProfileWithLockOrThrow({ agentDir, profileId, credential });
        const acquire = vi.fn(async () => {
          await logout();
          return { profiles: [{ profileId, credential }] };
        });
        configureProvider(false, acquire);
        boundary.password.mockImplementation(async () => {
          await logout();
          return credential.token;
        });
        const run =
          route === "login"
            ? runModelsAuthLoginFlowCore({
                provider,
                agent: "owner",
                config: cfg,
                runtime,
                prompter: createTestWizardPrompter(),
              })
            : route === "setup-token"
              ? modelsAuthSetupTokenCommand({ provider, agent: "owner", yes: true }, runtime)
              : route === "paste-token"
                ? modelsAuthPasteTokenCommand({ provider, profileId, agent: "owner" }, runtime)
                : modelsAuthPasteApiKeyCommand({ provider, profileId, agent: "owner" }, runtime);
        await expect(run).rejects.toThrow("Authentication changed during sign-in");
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toBeUndefined();
        expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Auth profile:"));
      });
    },
  );

  it.each(["plan", "before-persistent-effect"])(
    "refuses a stale import after delayed %s",
    async (boundaryName) => {
      await withFixture(async ({ cfg, agentDir, runtime, logout }) => {
        await upsertAuthProfileWithLockOrThrow({ agentDir, profileId, credential });
        const acquire = configureProvider(true);
        if (boundaryName === "plan") {
          boundary.plan.mockImplementation(async () => {
            await logout();
            return plan;
          });
        }
        const beforePersistentEffect = vi.fn(async () => {
          if (boundaryName === "before-persistent-effect") {
            await logout();
          }
        });
        await expect(
          runModelsAuthLoginFlowCore({
            provider,
            agent: "owner",
            config: cfg,
            runtime,
            prompter: createTestWizardPrompter(),
            beforePersistentEffect,
          }),
        ).rejects.toThrow("Authentication changed during sign-in");
        expect(beforePersistentEffect).toHaveBeenCalledOnce();
        expect(boundary.apply).not.toHaveBeenCalled();
        expect(acquire).not.toHaveBeenCalled();
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toBeUndefined();
      });
    },
  );

  it.each([false, true])(
    "rejects removed credentials after the Gateway refresh await (import=%s)",
    async (imported) => {
      await withFixture(async ({ agentDir, runtime, logout, login }) => {
        boundary.refresh.mockImplementationOnce(async () => {
          await logout();
        });
        await expect(login(imported)).rejects.toThrow("Authentication changed during sign-in");
        expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toBeUndefined();
        expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Auth profile:"));
      });
    },
  );

  it("does not accept an identical inherited credential after its saved local owner disappears", async () => {
    await withFixture(async ({ agentDir, runtime, login }) => {
      await upsertAuthProfileWithLockOrThrow({ profileId, credential });
      boundary.afterPromotion = async () => {
        await updateAuthProfileStoreWithLock({
          agentDir,
          updater: (store) => {
            delete store.profiles[profileId];
            return true;
          },
        });
      };
      await expect(login()).rejects.toThrow("Authentication changed during sign-in");
      expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toEqual(credential);
      expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Auth profile:"));
    });
  });

  it("verifies main login against its shared credential owner", async () => {
    await withFixture(async ({ agentDir, login }) => {
      await expect(login()).resolves.toMatchObject({ profiles: [{ profileId }] });
      expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toEqual(credential);
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toBeUndefined();
    }, "main");
  });

  it("retains the shared owner when a secondary OAuth sign-in is deduplicated", async () => {
    await withFixture(async ({ cfg, agentDir, runtime }) => {
      const oauth = {
        type: "oauth" as const,
        provider,
        access: "synthetic-oauth-access",
        refresh: "synthetic-oauth-refresh",
        expires: Date.now() + 60_000,
      };
      await upsertAuthProfileWithLockOrThrow({ profileId, credential: oauth });
      configureProvider(false, async () => ({ profiles: [{ profileId, credential: oauth }] }));
      await expect(
        runModelsAuthLoginFlowCore({
          provider,
          agent: "owner",
          config: cfg,
          runtime,
          prompter: createTestWizardPrompter(),
        }),
      ).resolves.toMatchObject({ profiles: [{ profileId, mode: "oauth" }] });
      expect(loadPersistedAuthProfileStore()?.profiles[profileId]).toEqual(oauth);
      expect(loadPersistedAuthProfileStore(agentDir)?.profiles[profileId]).toBeUndefined();
    });
  });
});
