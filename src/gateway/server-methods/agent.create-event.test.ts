/**
 * Tests agent creation event emission from gateway agent methods.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  forgetActiveSessionForShutdown,
  listActiveSessionsForShutdown,
} from "../active-sessions-shutdown-tracker.js";
import * as agentHandlerHelpers from "../agent-turn/agent-handler-helpers.js";
import * as sessionProject from "./session-create-project.js";

const configMocks = vi.hoisted(() => ({
  storePath: "",
  workspaceDir: "",
  getRuntimeConfig: vi.fn(() => ({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        workspace: configMocks.workspaceDir || "/tmp/openclaw-agent-create-event",
      },
    },
    session: {
      mainKey: "main",
      store: configMocks.storePath,
    },
  })),
}));

const agentIngressMocks = vi.hoisted(() => ({
  agentCommandFromIngress: vi.fn(async () => ({ ok: true })),
}));
const preparedRuntimeMocks = vi.hoisted(() => ({
  captured: vi.fn(),
  acquired: vi.fn(),
  releaseDispatch: vi.fn(async () => {}),
  releaseSelected: vi.fn(async () => {}),
}));

vi.mock("../../commands/agent.js", () => ({
  agentCommandFromGatewayIngress: agentIngressMocks.agentCommandFromIngress,
  agentCommandFromIngress: agentIngressMocks.agentCommandFromIngress,
}));

vi.mock("../../agents/prepared-model-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/prepared-model-runtime.js")>();
  const { getPreparedModelRuntimeBorrowedSnapshot } =
    await import("../../agents/prepared-model-runtime-generation-scope.js");
  return {
    ...actual,
    acquireAgentRunPreparedModelRuntime: vi.fn(async (input, options) => {
      preparedRuntimeMocks.acquired(
        getPreparedModelRuntimeBorrowedSnapshot(options.pluginGeneration),
        preparedRuntimeMocks.releaseDispatch.mock.calls.length,
      );
      return {
        [Symbol.asyncDispose]: preparedRuntimeMocks.releaseSelected,
        snapshot: input,
        pluginGeneration: options.pluginGeneration,
      };
    }),
    loadPublishedGatewayReplyDispatchRuntime: vi.fn(
      async ({
        agentId,
        onRuntimeLease,
      }: {
        agentId: string;
        onRuntimeLease?: (lease: unknown) => void;
      }) => {
        const runtime = {
          agentId,
          agentDir: configMocks.workspaceDir,
          config: configMocks.getRuntimeConfig(),
          pluginGeneration: { pluginMetadataSnapshot: {}, remoteCatalog: null },
          workspaceDir: configMocks.workspaceDir,
        };
        const snapshot = {
          ...runtime,
          metadataSnapshot: runtime.pluginGeneration.pluginMetadataSnapshot,
        };
        preparedRuntimeMocks.captured(snapshot);
        onRuntimeLease?.({
          snapshot,
          pluginGeneration: runtime.pluginGeneration,
          [Symbol.asyncDispose]: preparedRuntimeMocks.releaseDispatch,
        });
        return runtime;
      },
    ),
  };
});

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {},
}));

import { agentHandlers } from "./agent.js";

function firstMockCall<T extends readonly unknown[]>(mock: { mock: { calls: readonly T[] } }) {
  return mock.mock.calls[0];
}

describe("agent handler session create events", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-agent-create-event-");
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    tempDir = sessionDirs.make();
    storePath = path.join(tempDir, "sessions.json");
    configMocks.storePath = storePath;
    configMocks.workspaceDir = tempDir;
    setRuntimeConfigSnapshot(configMocks.getRuntimeConfig());
    configMocks.getRuntimeConfig.mockClear();
    agentIngressMocks.agentCommandFromIngress.mockClear();
    agentIngressMocks.agentCommandFromIngress.mockResolvedValue({ ok: true });
    Object.values(preparedRuntimeMocks).forEach((mock) => mock.mockClear());
    await fs.writeFile(storePath, "{}\n", "utf8");
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    for (const entry of listActiveSessionsForShutdown()) {
      forgetActiveSessionForShutdown(entry.sessionId);
    }
    vi.restoreAllMocks();
  });

  it.each(["immediate", "deferred workspace", "superseded catalog"] as const)(
    "settles runtime custody with %s preparation",
    async (preparation) => {
      const caseId = preparation.replaceAll(" ", "-");
      const sessionKey = `agent:main:subagent:create-test-${caseId}`;
      const runId = `idem-agent-create-event-${caseId}`;
      vi.spyOn(agentHandlerHelpers, "canPrepareAgentSessionWorktree").mockReturnValue(
        preparation === "deferred workspace",
      );
      vi.spyOn(sessionProject, "prepareSessionWorkspaceForRun").mockResolvedValue(undefined);
      if (preparation === "superseded catalog") {
        vi.mocked(acquireAgentRunPreparedModelRuntime).mockRejectedValueOnce(
          new PreparedModelRuntimePublicationSupersededError(
            "Accepted model catalog changed during runtime preparation",
          ),
        );
      }
      const broadcastToConnIds = vi.fn();
      const respond = vi.fn();
      const chatAbortControllers = new Map();
      let execution: Promise<unknown> | undefined;

      await expectDefined(agentHandlers.agent, "agentHandlers.agent test invariant").call(
        agentHandlers,
        {
          params: {
            message: "hi",
            sessionKey,
            idempotencyKey: runId,
          },
          respond,
          context: {
            trackExecution: (work: () => Promise<void>) => (execution = trackAsyncWork(work)),
            dedupe: new Map(),
            deps: {} as never,
            logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
            chatAbortControllers,
            addChatRun: vi.fn(),
            registerToolEventRecipient: vi.fn(),
            getRuntimeConfig: configMocks.getRuntimeConfig,
            getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
            broadcastToConnIds,
          } as never,
          client: null,
          isWebchatConnect: () => false,
          req: { id: "req-agent-create-event" } as never,
        },
      );

      const responseCall = firstMockCall(respond) as
        | [boolean, { status?: string; runId?: string }, unknown, { runId?: string }]
        | undefined;
      if (preparation === "superseded catalog") {
        expect(responseCall?.[0]).toBe(false);
        expect(responseCall?.[2]).toMatchObject({
          code: "UNAVAILABLE",
          message: "Model runtime changed before this turn started. Retry the request.",
          retryable: true,
          retryAfterMs: 0,
        });
        expect(execution).toBeUndefined();
        expect(agentIngressMocks.agentCommandFromIngress).not.toHaveBeenCalled();
        expect(preparedRuntimeMocks.releaseDispatch).toHaveBeenCalledOnce();
        expect(preparedRuntimeMocks.releaseSelected).not.toHaveBeenCalled();
        expect(chatAbortControllers.size).toBe(0);
        return;
      }
      expect(responseCall?.[0], JSON.stringify(responseCall)).toBe(true);
      expect(responseCall?.[1]?.status).toBe("accepted");
      expect(responseCall?.[1]?.runId).toBe(runId);
      expect(responseCall?.[2]).toBeUndefined();
      expect(responseCall?.[3]?.runId).toBe(runId);
      await execution;
      expect(preparedRuntimeMocks.acquired).toHaveBeenCalledExactlyOnceWith(
        preparedRuntimeMocks.captured.mock.calls[0]?.[0],
        0,
      );
      expect(preparedRuntimeMocks.releaseDispatch).toHaveBeenCalledOnce();
      expect(preparedRuntimeMocks.releaseSelected).toHaveBeenCalledOnce();
      await vi.waitFor(
        () => {
          const call = firstMockCall(broadcastToConnIds) as
            | [
                string,
                { sessionKey?: string; reason?: string },
                Set<string>,
                { dropIfSlow?: boolean; sessionKeys?: string[] },
              ]
            | undefined;
          expect(call?.[0]).toBe("sessions.changed");
          expect(call?.[1]?.sessionKey).toBe(sessionKey);
          expect(call?.[1]?.reason).toBe("create");
          expect(call?.[2]).toEqual(new Set(["conn-1"]));
          expect(call?.[3]).toEqual({
            agentId: "main",
            dropIfSlow: true,
          });
        },
        { timeout: 2_000, interval: 5 },
      );
    },
  );
});
