import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  ensureAuthProfileStore,
  saveAuthProfileStore,
} from "../../agents/auth-profiles.js";
import { AUTH_STORE_VERSION } from "../../agents/auth-profiles/constants.js";
import { oauthCred } from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { reloadSharedAuthStoreOwnership } from "../../agents/auth-profiles/path-resolve.js";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { withAuthProfileTestState } from "../../agents/auth-profiles/profile-mutations.test-support.js";
import { SHARED_AUTH_STORE_STATE_KEY } from "../../agents/auth-profiles/sqlite-json.js";
import {
  readPersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "../../agents/auth-profiles/sqlite.js";
import { loadPersistedAuthProfileState } from "../../agents/auth-profiles/state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { writeConfigMachineState } from "../../state/config-machine-state-write.js";

const commandState = vi.hoisted(() => ({
  agentDir: "",
  config: {} as OpenClawConfig,
}));

vi.mock("./load-config.js", () => ({
  loadModelsConfig: vi.fn(async () => commandState.config),
}));

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    resolveModelsTargetAgent: vi.fn(() => ({ agentId: "main", agentDir: commandState.agentDir })),
  };
});

vi.mock("./auth-refresh.js", () => ({
  refreshRunningGatewayAuthState: vi.fn(async () => undefined),
}));

const { modelsAuthOrderClearCommand, modelsAuthOrderSetCommand } = await import("./auth-order.js");

function createRuntime(): RuntimeEnv & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    log: (message: string) => logs.push(message),
    error: () => {},
  } as unknown as RuntimeEnv & { logs: string[] };
}

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  vi.clearAllMocks();
});

describe("models auth order persisted ownership", () => {
  it("clears a local override while preserving and reporting the inherited shared order", async () => {
    await withAuthProfileTestState(
      "openclaw-models-auth-order-clear-",
      async ({ agentDir, agentDirFor }) => {
        commandState.agentDir = agentDir;
        commandState.config = {
          auth: { order: { openai: ["openai:second", "openai:first"] } },
        };
        writeConfigMachineState(
          SHARED_AUTH_STORE_STATE_KEY,
          { location: "state-db" },
          { env: process.env },
        );
        reloadSharedAuthStoreOwnership(process.env);
        saveAuthProfileStore({
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:first": oauthCred({
              provider: "openai",
              access: "first",
              refresh: "first-refresh",
              expires: Date.now() + 60_000,
            }),
            "openai:second": oauthCred({
              provider: "openai",
              access: "second",
              refresh: "second-refresh",
              expires: Date.now() + 60_000,
            }),
          },
          order: { openai: ["openai:first", "openai:second"] },
        });
        writePersistedAuthProfileStoreRaw({ version: AUTH_STORE_VERSION, profiles: {} }, agentDir);
        clearRuntimeAuthProfileStoreSnapshots();

        const runtime = createRuntime();
        await modelsAuthOrderSetCommand(
          { provider: "openai", order: ["openai:second", "openai:first"] },
          runtime,
        );
        expect(loadPersistedAuthProfileState(agentDir).order?.openai).toEqual([
          "openai:second",
          "openai:first",
        ]);

        await modelsAuthOrderClearCommand({ provider: "openai" }, runtime);

        expect(readPersistedAuthProfileStateRaw(agentDir)).toBeNull();
        expect(loadPersistedAuthProfileStore()?.order?.openai).toEqual([
          "openai:first",
          "openai:second",
        ]);
        expect(ensureAuthProfileStore(agentDirFor("worker")).order?.openai).toEqual([
          "openai:first",
          "openai:second",
        ]);
        expect(runtime.logs).toContain(
          "Auth profile order override cleared; inherited shared order remains active: openai:first, openai:second.",
        );
      },
      { clearOAuthDir: true },
    );
  });
});
