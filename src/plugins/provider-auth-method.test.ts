import path from "node:path";
import { afterEach, aroundEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../infra/state-database-coordinator.js";
import { createNonExitingRuntime } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { useIsolatedStateGuard } from "../test-utils/state-path-guard.js";
import { runProviderPluginAuthMethod } from "./provider-auth-choice.js";
import { runProviderPluginAuthMethodUnpersisted } from "./provider-auth-method.js";
import type { ProviderAuthMethod } from "./provider-authentication.types.js";

const { openHostBrowser } = vi.hoisted(() => ({
  openHostBrowser: vi.fn(async () => true),
}));
vi.mock("../infra/browser-open.js", () => ({ openUrl: openHostBrowser }));

// Keep the real SQLite lifecycle coordinators under the isolated worker home.
aroundEach(async (runTest) => {
  const testHome = process.env.OPENCLAW_TEST_HOME;
  if (!testHome) {
    throw new Error("Provider auth tests require an isolated test home.");
  }
  await withStateDatabaseCoordinatorRuntimeDirectory(testHome, runTest);
});

useIsolatedStateGuard();
afterEach(() => vi.clearAllMocks());

const destination = "https://provider.example/oauth?state=fixture-state";
const browserMethod: ProviderAuthMethod = {
  id: "oauth",
  label: "OAuth",
  kind: "oauth",
  run: async (ctx) => {
    await ctx.openUrl(destination);
    return { profiles: [] };
  },
};

const options = {
  config: {},
  runtime: createNonExitingRuntime(),
  method: browserMethod,
};

describe("runProviderPluginAuthMethodUnpersisted", () => {
  it.each([false, true])(
    "delivers destinations to presenting clients (remote=%s)",
    async (isRemote) => {
      const openUrl = vi.fn(async () => undefined);
      await runProviderPluginAuthMethodUnpersisted({
        ...options,
        isRemote,
        prompter: createWizardPrompter({ openUrl }),
        method: {
          ...browserMethod,
          run: async (ctx) => {
            expect(ctx.isRemote).toBe(isRemote);
            return browserMethod.run(ctx);
          },
        },
      });
      expect(openUrl).toHaveBeenCalledExactlyOnceWith(destination);
      expect(openHostBrowser).not.toHaveBeenCalled();
    },
  );

  it.each([false, undefined, true])(
    "preserves host opening for non-presenting CLI prompts (remote=%s)",
    async (isRemote) => {
      await runProviderPluginAuthMethodUnpersisted({
        ...options,
        isRemote,
        prompter: createWizardPrompter(),
      });
      if (isRemote === true) {
        expect(openHostBrowser).not.toHaveBeenCalled();
      } else {
        expect(openHostBrowser).toHaveBeenCalledExactlyOnceWith(destination);
      }
    },
  );

  it("keeps explicit browser overrides authoritative", async () => {
    const openUrl = vi.fn(async () => undefined);
    const presentUrl = vi.fn(async () => undefined);
    await runProviderPluginAuthMethodUnpersisted({
      ...options,
      isRemote: false,
      openUrl,
      prompter: createWizardPrompter({ openUrl: presentUrl }),
    });
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(destination);
    expect(presentUrl).not.toHaveBeenCalled();
    expect(openHostBrowser).not.toHaveBeenCalled();
  });
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

describe("provider auth scoped ownership and persistence", () => {
  it.each([
    "scoped",
    "missing-agent-dir",
    "missing-workspace",
    "cancelled",
    "retired",
    "failed",
  ] as const)("keeps the selected owner through %s provider setup", async (scenario) => {
    const root = tempDirs.make("provider-auth-selected-owner-", process.env.OPENCLAW_TEST_HOME);
    const stateDir = path.join(root, "state");
    const opsDir = path.join(stateDir, "agents", "ops", "agent");
    const siblingDir = path.join(stateDir, "agents", "sibling", "agent");
    const workspace = path.join(root, "ops-workspace");
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          ops: { agentDir: opsDir, workspace },
          sibling: { agentDir: siblingDir, workspace: path.join(root, "sibling-workspace") },
        },
      },
    };
    await withEnvAsync(
      {
        HOME: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      async () => {
        const abort = new AbortController();
        let current = true;
        const run = vi.fn(async (ctx: Parameters<ProviderAuthMethod["run"]>[0]) => {
          expect(ctx.agentDir).toBe(opsDir);
          expect(ctx.workspaceDir).toBe(workspace);
          await Promise.resolve();
          if (scenario === "cancelled") {
            abort.abort(new Error("Setup cancelled"));
          }
          if (scenario === "retired") {
            current = false;
          }
          if (scenario === "failed") {
            throw new Error("Provider failed");
          }
          return {
            profiles: [
              {
                profileId: "fixture:ops",
                credential: {
                  type: "api_key" as const,
                  provider: "fixture",
                  key: "synthetic-test-only",
                },
              },
            ],
          };
        });
        const result = runProviderPluginAuthMethod({
          config,
          runtime: createNonExitingRuntime(),
          prompter: createWizardPrompter(),
          method: { id: "api-key", label: "Fixture", kind: "api_key", run },
          ...(scenario !== "missing-agent-dir" ? { agentDir: opsDir } : {}),
          ...(scenario !== "missing-workspace" ? { workspaceDir: workspace } : {}),
          ...(["missing-agent-dir", "missing-workspace"].includes(scenario)
            ? { agentId: "ops" }
            : {}),
          signal: abort.signal,
          beforePersistentEffect: () => {
            if (!current) {
              throw new Error("Setup retired");
            }
          },
        });
        if (["cancelled", "retired", "failed"].includes(scenario)) {
          await expect(result).rejects.toThrow(/Setup cancelled|Setup retired|Provider failed/);
        } else {
          await expect(result).resolves.toMatchObject({
            config: {
              auth: {
                profiles: {
                  "fixture:ops": { provider: "fixture", mode: "api_key" },
                },
              },
            },
          });
        }
        expect(run).toHaveBeenCalledOnce();
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        const read = (dir: string) =>
          ensureAuthProfileStore(dir, { readOnly: true, syncExternalCli: false }).profiles;
        const expected = ["cancelled", "retired", "failed"].includes(scenario)
          ? {}
          : {
              "fixture:ops": { type: "api_key", provider: "fixture", key: "synthetic-test-only" },
            };
        expect(read(opsDir)).toEqual(expected);
        expect(read(siblingDir)).toEqual({});
      },
    );
  });
});
