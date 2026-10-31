import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { EmbeddedAgentRunResult } from "../agents/embedded-agent-runner/types.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import {
  PreparedModelRuntimeOwnerNotPublishedError,
  PreparedModelRuntimePublicationSupersededError,
} from "../agents/prepared-model-runtime.errors.js";
import {
  AGENT_RUN_SUPERSEDED_STOP_REASON,
  createAgentRunSupersededAbortError,
} from "../agents/run-termination.js";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import * as configModule from "../config/config.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  createSystemAgentSession,
  runSystemAgentTurn as runSystemAgentTurnImpl,
} from "./agent-turn.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  createSystemAgentVerifiedInferenceTestFixture as createSystemAgentVerifiedInferenceTestFixtureImpl,
  createSystemAgentPluginMetadataTestSnapshot,
  type SystemAgentPluginMetadataTestSnapshot,
} from "./system-agent.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let pluginMetadataSnapshot: SystemAgentPluginMetadataTestSnapshot | undefined;

const runSystemAgentTurn: typeof runSystemAgentTurnImpl = (...args) =>
  pluginMetadataSnapshot!.run(() => runSystemAgentTurnImpl(...args));

const createSystemAgentVerifiedInferenceTestFixture: typeof createSystemAgentVerifiedInferenceTestFixtureImpl =
  (...args) =>
    pluginMetadataSnapshot!.run(
      () => createSystemAgentVerifiedInferenceTestFixtureImpl(...args),
      args[0],
    );

beforeAll(() => {
  pluginMetadataSnapshot = createSystemAgentPluginMetadataTestSnapshot();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

vi.mock("../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/embedded-agent.js")>()),
  runEmbeddedAgent: vi.fn(),
}));

describe("system-agent terminal failure cleanup", () => {
  it.each([
    {
      name: "runner rejection",
      runEmbeddedAgent: async () => {
        throw new Error("provider unavailable");
      },
      guidance: "The inference request failed",
    },
    {
      name: "superseded generation",
      runEmbeddedAgent: async () => {
        throw createAgentRunSupersededAbortError();
      },
      guidance: "superseded",
    },
    {
      name: "superseded prepared runtime generation",
      runEmbeddedAgent: async () => {
        throw new PreparedModelRuntimePublicationSupersededError(
          "prepared model runtime plugin generation was superseded",
        );
      },
      guidance: "runtime was superseded",
    },
    {
      name: "unpublished prepared runtime owner",
      runEmbeddedAgent: async () => {
        throw new PreparedModelRuntimeOwnerNotPublishedError("no runtime owner published");
      },
      guidance: "prepared inference runtime became unavailable or was superseded",
    },
    {
      name: "superseded terminal result with retained text",
      runEmbeddedAgent: async () => ({
        meta: {
          durationMs: 0,
          finalAssistantVisibleText: "An obsolete reply",
          aborted: true,
          stopReason: AGENT_RUN_SUPERSEDED_STOP_REASON,
        },
      }),
      guidance: "runtime was superseded",
    },
    {
      name: "empty model output",
      runEmbeddedAgent: async () => ({ payloads: [], meta: { durationMs: 0 } }),
      guidance: "The inference request failed",
    },
    {
      name: "hidden reasoning",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "Considering the answer", isReasoning: true }],
        meta: { durationMs: 0 },
      }),
    },
    {
      name: "hidden commentary",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "Checking the gateway", isCommentary: true }],
        meta: { durationMs: 0 },
      }),
    },
    {
      name: "explicitly hidden output",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "Private model output", visible: false }],
        meta: { durationMs: 0 },
      }),
    },
    {
      name: "status notice",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "Still working", isStatusNotice: true }],
        meta: { durationMs: 0 },
      }),
    },
    {
      name: "silent reply despite a retained payload",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "NO_REPLY" }],
        meta: { durationMs: 0, terminalReply: { disposition: "silent" } },
      }),
    },
    {
      name: "silent terminal fact with an earlier visible draft",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "Retained draft, not a final result." }],
        meta: { durationMs: 0, terminalReply: { disposition: "silent" } },
      }),
    },
    {
      name: "raw-only hidden metadata",
      runEmbeddedAgent: async () => ({
        meta: { durationMs: 0, finalAssistantRawText: "Hidden draft" },
      }),
    },
    {
      name: "timed-out turn with retained visible text",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "The setup turn timed out.", isError: true }],
        meta: {
          durationMs: 0,
          finalAssistantVisibleText: "I'll begin by checking the available models.",
          error: { kind: "incomplete_turn", message: "The setup turn timed out." },
          stopReason: "timeout",
        },
      }),
      guidance: "timed out",
    },
    {
      name: "failed turn with partial payload text",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "I'll check the gateway." }],
        meta: {
          durationMs: 0,
          error: { kind: "incomplete_turn", message: "The provider failed." },
        },
      }),
    },
    {
      name: "blocked turn with partial payload text",
      runEmbeddedAgent: async () => ({
        payloads: [{ text: "I'll check the gateway." }],
        meta: { durationMs: 0, livenessState: "blocked" },
      }),
    },
    {
      name: "abandoned turn with retained visible text",
      runEmbeddedAgent: async () => ({
        meta: {
          durationMs: 0,
          finalAssistantVisibleText: "I'll check the gateway.",
          livenessState: "abandoned",
        },
      }),
    },
  ] satisfies Array<{
    name: string;
    runEmbeddedAgent: () => Promise<EmbeddedAgentRunResult>;
    guidance?: string;
  }>)("clears partial session state after $name", async ({ runEmbeddedAgent, guidance }) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-turn-failure-"));

    const config: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    };
    const { binding } = await createSystemAgentVerifiedInferenceTestFixture(config);
    const session = createSystemAgentSession(binding);
    session.proposalRef.current = "partial-proposal";
    session.proposalRef.operation = { kind: "setup" };
    session.cliSession = {
      routeKey: "stale-route",
      binding: { sessionId: "uncertain-cli-session" },
    };

    vi.spyOn(embeddedAgent, "runEmbeddedAgent").mockImplementation(async (params) => {
      expect(params.terminalReplyExpectation).toBe("result-required");
      return runEmbeddedAgent();
    });
    vi.spyOn(configModule, "readConfigFileSnapshot").mockImplementation(async () => ({
      ...createTestConfigSnapshot(config),
      hash: "hash",
      raw: null,
      parsed: config,
    }));
    const failure = runSystemAgentTurn({
      input: "hello",
      surface: "gateway",
      approvalArmed: false,
      session,
    });
    await expect(failure).rejects.toBeInstanceOf(SystemAgentInferenceUnavailableError);
    const message = await failure.catch((error: unknown) =>
      error instanceof Error ? error.message : String(error),
    );
    expect(message).not.toContain("openclaw onboard");
    if (guidance) {
      expect(message).toContain(guidance);
    }
    expect(session.proposalRef.current).toBeUndefined();
    expect(session.proposalRef.operation).toBeUndefined();
    expect(session.cliSession).toBeUndefined();
  });
});
