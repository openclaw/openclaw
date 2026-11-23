import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import type { RealtimeVoiceBridgeSession } from "../talk/session-runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createMeetingRealtimeEngineBindings } from "./agent-consult.js";
import { TEST_MEETING_PLATFORM_METADATA } from "./observation-provenance.test-support.js";

// The real fork writes through the SQLite agent store, which needs its main-thread
// host owner; vitest workers lack it. Root admission is checked before the fork.
vi.mock("../auto-reply/reply/session-fork.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/reply/session-fork.js")>()),
  forkSessionEntryFromParent: async () => ({
    status: "skipped" as const,
    reason: "decision-skip" as const,
    sessionEntry: { sessionId: "", updatedAt: 1 },
  }),
}));

let state: OpenClawTestState;

beforeEach(async () => {
  resetGatewayWorkAdmission();
  state = await createOpenClawTestState({ label: "meeting-consult", layout: "state-only" });
});

afterEach(async () => {
  resetGatewayWorkAdmission();
  await state.cleanup();
});

function createBindings() {
  const sessionStore: Record<string, Record<string, unknown>> = {};
  const runEmbeddedAgent = vi.fn(async () => ({ payloads: [{ text: "391." }], meta: {} }));
  const agent = {
    runEmbeddedAgent,
    resolveAgentDir: () => state.statePath("agent"),
    resolveAgentWorkspaceDir: () => state.statePath("workspace"),
    ensureAgentWorkspace: async () => {},
    resolveAgentTimeoutMs: () => 30_000,
    session: {
      resolveStorePath: () => state.statePath("sessions.json"),
      getSessionEntry: ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey],
      getSessionEntryAsync: async ({ sessionKey }: { sessionKey: string }) =>
        sessionStore[sessionKey],
      prepareSessionEntryPatch: async (params: {
        sessionKey: string;
        fallbackEntry?: Record<string, unknown>;
        prepare: (entry: Record<string, unknown>, ctx: unknown) => unknown;
      }) => {
        const existing = sessionStore[params.sessionKey] ?? params.fallbackEntry;
        if (!existing) {
          return null;
        }
        const patch = (await params.prepare({ ...existing }, {})) as Record<string, unknown>;
        const next = { ...existing, ...patch };
        sessionStore[params.sessionKey] = next;
        return next;
      },
    },
  };
  const bindings = createMeetingRealtimeEngineBindings({
    platform: TEST_MEETING_PLATFORM_METADATA,
    config: { realtime: { toolPolicy: "safe-read-only" } },
    fullConfig: {},
    runtime: { agent } as never,
    logger: { warn: vi.fn() } as never,
  });
  return { bindings, runEmbeddedAgent };
}

// Meeting creation runs inside a request root (for example googlemeet.create).
// Realtime callbacks that start consults are registered in that async chain and
// fire after the request released its root, so they inherit a released root.
async function inReleasedCreationRoot<T>(run: () => Promise<T>): Promise<T> {
  const creationRoot = tryBeginGatewayRootWorkAdmission("ws:googlemeet.create");
  if (!creationRoot) {
    throw new Error("Expected creation root admission");
  }
  const { promise: spoken, resolve: speak } = Promise.withResolvers<void>();
  let consult: Promise<T> | undefined;
  await creationRoot.run(async () => {
    consult = (async () => {
      await spoken;
      return await run();
    })();
  });
  creationRoot.release();
  speak();
  return await consult!;
}

it("answers agent-mode and native-delegation consults after the creation root released", async () => {
  const { bindings, runEmbeddedAgent } = createBindings();
  await expect(
    inReleasedCreationRoot(() =>
      bindings.consultAgent({
        meetingSessionId: "meeting-1",
        args: { question: "What is 17 times 23?" },
        transcript: [],
      }),
    ),
  ).resolves.toEqual({ text: "391." });
  expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("answers a bidi function-tool consult after the creation root released", async () => {
  const { bindings, runEmbeddedAgent } = createBindings();
  const submitToolResult = vi.fn(async () => {});
  await inReleasedCreationRoot(() =>
    bindings.handleToolCall({
      meetingSessionId: "meeting-1",
      transcript: [],
      strategy: "bidi",
      session: {
        bridge: { supportsToolResultContinuation: false },
        submitToolResult,
      } as unknown as RealtimeVoiceBridgeSession,
      event: {
        itemId: "item-1",
        callId: "call-1",
        name: "openclaw_agent_consult",
        args: { question: "What is 17 times 23?" },
      },
      onTalkEvent: () => {},
    }),
  );
  expect(submitToolResult).toHaveBeenCalledWith("call-1", { text: "391." });
  expect(runEmbeddedAgent).toHaveBeenCalledOnce();
  expect(getActiveGatewayRootWorkCount()).toBe(0);
});

it("still refuses a consult while the Gateway drains for restart", async () => {
  const { bindings, runEmbeddedAgent } = createBindings();
  markGatewayRestartDraining();
  await expect(
    bindings.consultAgent({
      meetingSessionId: "meeting-1",
      args: { question: "What is 17 times 23?" },
      transcript: [],
    }),
  ).rejects.toBeInstanceOf(GatewayDrainingError);
  expect(runEmbeddedAgent).not.toHaveBeenCalled();
});
