// Exercises the shipped models auth login command across shared credential and local order owners.
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createOAuthRefreshCredential } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { setAuthProfileOrder } from "../agents/auth-profiles/profiles.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { loadAuthProfileStoreForRuntime } from "../agents/auth-profiles/store-runtime.js";
import * as providerAuthPersistence from "../plugins/provider-auth-persistence.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { registerModelsCli } from "./models-cli.js";
import { defaultRuntime } from "./models-cli.runtime.js";
import { createCliTtyMock } from "./test-runtime-capture.js";

const FRESH_PROFILE_ID = "openai:fresh-login";
const ORDER_BUSY_MESSAGE =
  "The auth profile was saved, but its order could not be updated because the auth store is busy. Wait a moment, then retry the login.";
const STALE_PROFILE_ID = "openai:stale-login";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(async () => ({ refreshed: true })),
  runAuth: vi.fn<ProviderPlugin["auth"][number]["run"]>(async () => ({
    profiles: [
      {
        profileId: "openai:fresh-login",
        credential: createOAuthRefreshCredential(),
      },
    ],
  })),
}));

vi.mock("../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../gateway/call.js")>()),
  callGateway: mocks.callGateway,
}));
vi.mock("../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: () => undefined,
  resolvePluginSetupRegistry: () => ({ providers: [] }),
}));
// mock-isolation: Use a synthetic OAuth provider without loading installed providers or opening a real login.
vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: () =>
    [
      {
        id: "openai",
        label: "OpenAI",
        auth: [
          // Like Sign in with ChatGPT, the method matches accounts, so relogin reads local profiles.
          {
            id: "oauth",
            label: "OAuth",
            kind: "oauth",
            run: mocks.runAuth,
            matchesPersonalAccount: () => false,
          },
        ],
      },
    ] satisfies ProviderPlugin[],
}));

describe("models auth login owner integration", () => {
  let lock: DatabaseSync | undefined;

  function withLoginState(run: Parameters<typeof withOpenClawTestState>[1]) {
    return withOpenClawTestState(
      { label: "models-auth-login-owner", scenario: "minimal" },
      async (state) => {
        await state.writeConfig({
          agents: { ownership: "explicit", entries: { main: {}, coder: {} } },
          auth: { order: { openai: [STALE_PROFILE_ID] } },
        });
        writeConfigMachineState("auth.sharedStore", { location: "state-db" }, { env: state.env });
        const tty = createCliTtyMock([process.stdin]);
        tty.set(true);
        try {
          return await run(state);
        } finally {
          if (lock?.isOpen) {
            if (lock.isTransaction) {
              lock.exec("ROLLBACK");
            }
            lock.close();
          }
          lock = undefined;
          tty.restore();
          vi.clearAllMocks();
          vi.restoreAllMocks();
        }
      },
    );
  }

  const login = (agent = "main", ...extra: string[]) =>
    runRegisteredCli({
      register: registerModelsCli,
      argv: ["models", "auth", "login", "--provider", "openai", "--agent", agent, ...extra],
    });
  const expectSavedCredential = () =>
    expect(loadPersistedAuthProfileStore()?.profiles[FRESH_PROFILE_ID]).toMatchObject({
      type: "oauth",
      provider: "openai",
    });

  it("promotes a relocated shared login through the shipped CLI command", async () => {
    await withLoginState(async (state) => {
      await login();

      expectSavedCredential();
      expect(
        loadPersistedAuthProfileStore(state.agentDir())?.profiles[FRESH_PROFILE_ID],
      ).toBeUndefined();
      expect(loadAuthProfileStoreForRuntime(state.agentDir()).order?.openai).toEqual([
        FRESH_PROFILE_ID,
        STALE_PROFILE_ID,
      ]);
      expect(mocks.callGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "models.authRefresh",
          params: { operation: "login", agentId: "main" },
          requireLocalBackendSharedAuth: true,
        }),
      );
    });
  });

  it.each([
    { prior: false, agent: "main", runtime: { id: "openclaw" } },
    { prior: true, agent: "main", runtime: undefined },
    // coder has no OpenAI profile of its own; it inherits main's shared login.
    { prior: true, agent: "coder", runtime: undefined },
  ])(
    "pins the login's runtime only on a first provider login (prior: $prior, agent: $agent)",
    async ({ prior, agent, runtime }) => {
      await withLoginState(async (state) => {
        if (prior) {
          await login();
        }
        // A named profile hides the agent's other OpenAI profiles from the plugin, not from the host.
        mocks.runAuth.mockResolvedValueOnce({
          profiles: [{ profileId: "openai:work", credential: createOAuthRefreshCredential() }],
          defaultModel: "openai/gpt-5.5",
          agentRuntimeId: "openclaw",
        });
        await login(agent, "--profile-id", "openai:work");

        const config = JSON.parse(await fs.readFile(state.configPath, "utf8"));
        expect(config.agents.entries[agent].models?.["openai/gpt-5.5"]?.agentRuntime).toEqual(
          runtime,
        );
      });
    },
  );

  it("reports partial success when the local order owner is busy", async () => {
    await withLoginState(async (state) => {
      expect(
        await setAuthProfileOrder({
          agentDir: state.agentDir(),
          provider: "openai",
          order: [STALE_PROFILE_ID],
        }),
      ).not.toBeNull();
      const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
      const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
      vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new Error(`exit:${code}`);
      });
      const persist = providerAuthPersistence.persistProviderAuthProfilesAfterLogin;
      vi.spyOn(
        providerAuthPersistence,
        "persistProviderAuthProfilesAfterLogin",
      ).mockImplementationOnce(async (params) => {
        const profiles = await persist(params);
        lock = new DatabaseSync(resolveAuthProfileDatabasePath(state.agentDir()));
        lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
        return profiles;
      });

      await expect(login()).rejects.toThrow("exit:1");

      expect(error).toHaveBeenCalledWith(ORDER_BUSY_MESSAGE);
      expect(log).not.toHaveBeenCalledWith(
        expect.stringContaining(`Auth profile: ${FRESH_PROFILE_ID}`),
      );
      expect(mocks.callGateway).not.toHaveBeenCalled();
      expectSavedCredential();
      expect(loadPersistedAuthProfileStore(state.agentDir())?.order?.openai).toEqual([
        STALE_PROFILE_ID,
      ]);
    });
  });
});
