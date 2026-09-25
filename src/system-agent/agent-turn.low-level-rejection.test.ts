import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.js";
import { createSystemAgentSession, type SystemAgentSession } from "./agent-turn.js";
import {
  runSystemAgentTurnWithDeps as runSystemAgentTurnWithDepsImpl,
  type SystemAgentTurnDeps,
} from "./agent-turn.test-support.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  createSystemAgentVerifiedInferenceTestFixture as createSystemAgentVerifiedInferenceTestFixtureImpl,
  installSystemAgentClaudeCliBackendTestFixture,
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

vi.mock("../plugins/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/providers.js")>()),
  resolveOwningPluginIdsForModelRefs: vi.fn(() => []),
  resolveOwningPluginIdsForProviderRef: vi.fn(() => []),
}));

vi.mock("../agents/harness/runtime-plugin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/harness/runtime-plugin.js")>()),
  resolveAgentHarnessOwnerPluginIds: vi.fn(({ runtime }: { runtime: string }) =>
    runtime === "codex" ? ["codex"] : [],
  ),
}));

type RunEmbeddedAgentParams = Parameters<NonNullable<SystemAgentTurnDeps["runEmbeddedAgent"]>>[0];

const mocks = vi.hoisted(() => ({
  runEmbeddedAgent: vi.fn(async (_params: RunEmbeddedAgentParams) => ({
    meta: { finalAssistantVisibleText: "ready" },
  })),
}));

vi.mock("../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgent,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: vi.fn(async () => ({
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
    runtimeConfig: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
    sourceConfig: { agents: { defaults: { model: { primary: "openai/gpt-5.5" } } } },
    issues: [],
  })),
}));

const tempDirs = createTempDirTracker();
let restoreCliBackendFixture: (() => void) | undefined;
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

const runSystemAgentTurnWithDeps: typeof runSystemAgentTurnWithDepsImpl = (...args) =>
  pluginMetadataSnapshot!.run(() => runSystemAgentTurnWithDepsImpl(...args));

const createSystemAgentVerifiedInferenceTestFixture: typeof createSystemAgentVerifiedInferenceTestFixtureImpl =
  (...args) =>
    pluginMetadataSnapshot!.run(
      () => createSystemAgentVerifiedInferenceTestFixtureImpl(...args),
      args[0],
    );

function useTempStateDir(): string {
  const stateDir = tempDirs.make("openclaw-turn-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

  return stateDir;
}

function configSnapshot(config: OpenClawConfig): ConfigFileSnapshot {
  return {
    exists: true,
    valid: true,
    path: "/tmp/openclaw.json",
    hash: "hash",
    config,
    runtimeConfig: config,
    sourceConfig: config,
    raw: JSON.stringify(config),
    parsed: config,
    resolved: config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

async function createVerifiedSession(config: OpenClawConfig) {
  const fixture = await createSystemAgentVerifiedInferenceTestFixture(config);
  return {
    ...fixture,
    session: createSystemAgentSession(fixture.binding),
  };
}

beforeAll(() => {
  pluginMetadataSnapshot = createSystemAgentPluginMetadataTestSnapshot();
});

beforeEach(() => {
  restoreCliBackendFixture = installSystemAgentClaudeCliBackendTestFixture();
});

afterEach(() => {
  restoreCliBackendFixture?.();
  restoreCliBackendFixture = undefined;
  vi.unstubAllEnvs();

  vi.clearAllMocks();
  tempDirs.cleanup();
});
describe("runSystemAgentTurn low-level rejection", () => {
  it("rejects a low-level session without verified inference before lookup or run", async () => {
    useTempStateDir();
    const runCliAgent = vi.fn();
    const runEmbeddedAgent = vi.fn();
    const readConfigFileSnapshot = vi.fn(async () =>
      configSnapshot({ agents: { defaults: { model: "openai/gpt-5.5" } } }),
    );
    const unverifiedSession = {
      sessionId: "openclaw-unverified",
      proposalRef: {},
    } as unknown as SystemAgentSession;

    await expect(
      runSystemAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "openai/stale-overview-model" } as never,
          surface: "gateway",
          approvalArmed: false,
          session: unverifiedSession,
        },
        {
          runCliAgent: runCliAgent as never,
          runEmbeddedAgent: runEmbeddedAgent as never,
          readConfigFileSnapshot: readConfigFileSnapshot as never,
        },
      ),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(runCliAgent).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("converts route-planning failures to a typed error and clears session state", async () => {
    useTempStateDir();
    const config = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    } satisfies OpenClawConfig;
    const { session, deps } = await createVerifiedSession(config);
    session.proposalRef.current = "partial-proposal";
    session.cliSession = {
      routeKey: "stale-route",
      binding: { sessionId: "uncertain-cli-session" },
    };

    await expect(
      runSystemAgentTurnWithDeps(
        {
          input: "hello",
          overview: { defaultModel: "openai/gpt-5.5" } as never,
          surface: "gateway",
          approvalArmed: false,
          session,
        },
        {
          ...deps,
          readConfigFileSnapshot: vi.fn(async () => {
            throw new Error("config read failed");
          }) as never,
        },
      ),
    ).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    expect(session.proposalRef.current).toBeUndefined();
    expect(session.cliSession).toBeUndefined();
  });
});
