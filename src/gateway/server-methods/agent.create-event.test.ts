import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
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
  getRuntimeConfig: () => ({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        workspace: configMocks.workspaceDir,
      },
    },
    session: { mainKey: "main", store: configMocks.storePath },
  }),
}));

const agentCommandFromIngress = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const preparedRuntimeMocks = vi.hoisted(() => ({
  captured: vi.fn(),
  acquired: vi.fn(),
  releaseDispatch: vi.fn(async () => {}),
  releaseSelected: vi.fn(async () => {}),
}));

// mock-isolation: Exercise ingress admission without executing agent commands.
vi.mock("../../commands/agent.js", () => ({
  agentCommandFromGatewayIngress: agentCommandFromIngress,
  agentCommandFromIngress,
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
        run: <T>(run: () => T): T => run(),
        [Symbol.asyncDispose]: preparedRuntimeMocks.releaseSelected,
        snapshot: input,
        pluginGeneration: options.pluginGeneration,
      };
    }),
    async loadPublishedGatewayReplyDispatchRuntime({
      agentId,
      onRuntimeLease,
    }: {
      agentId: string;
      onRuntimeLease?: (lease: unknown) => void;
    }) {
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
        run: <T>(run: () => T): T => run(),
        [Symbol.asyncDispose]: preparedRuntimeMocks.releaseDispatch,
      });
      return runtime;
    },
  };
});

// mock-isolation: The ingress fixture does not need the process runtime singleton.
vi.mock("../../runtime.js", () => ({ defaultRuntime: {} }));

import { agentHandlers } from "./agent.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-agent-create-event-");

beforeEach(async () => {
  configMocks.workspaceDir = sessionDirs.make();
  configMocks.storePath = path.join(configMocks.workspaceDir, "sessions.json");
  setRuntimeConfigSnapshot(configMocks.getRuntimeConfig());
  agentCommandFromIngress.mockClear();
  Object.values(preparedRuntimeMocks).forEach((mock) => mock.mockClear());
  await fs.writeFile(configMocks.storePath, "{}\n", "utf8");
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
        new PreparedModelRuntimePublicationSupersededError(),
      );
    }
    const broadcastToConnIds = vi.fn();
    const respond = vi.fn();
    let execution: Promise<unknown> | undefined;

    const agent = expectDefined(agentHandlers.agent, "agent handler missing");
    await agent({
      params: { message: "hi", sessionKey, idempotencyKey: runId },
      respond,
      context: {
        trackExecution: (work: () => Promise<void>) => (execution = trackAsyncWork(work)),
        dedupe: new Map(),
        deps: {} as never,
        logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
        addChatRun: vi.fn(),
        registerToolEventRecipient: vi.fn(),
        getRuntimeConfig: configMocks.getRuntimeConfig,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
        broadcastToConnIds,
      } as never,
      client: null,
      isWebchatConnect: () => false,
      req: { id: "req-agent-create-event" } as never,
    });

    const responseCall = respond.mock.calls[0];
    await execution;
    expect(preparedRuntimeMocks.releaseDispatch).toHaveBeenCalledOnce();
    expect(preparedRuntimeMocks.releaseSelected).toHaveBeenCalledTimes(
      preparation === "superseded catalog" ? 0 : 1,
    );
    if (preparation === "superseded catalog") {
      expect(responseCall?.[0]).toBe(false);
      expect(responseCall?.[2]).toMatchObject({
        code: "UNAVAILABLE",
        message: "Model runtime changed before this turn started. Retry the request.",
        retryable: true,
        retryAfterMs: 0,
      });
      expect(execution).toBeUndefined();
      expect(agentCommandFromIngress).not.toHaveBeenCalled();
      expect(rpcSourceTesting.has(runId)).toBe(false);
      return;
    }
    expect(responseCall).toEqual([
      true,
      expect.objectContaining({ status: "accepted", runId }),
      undefined,
      expect.objectContaining({ runId }),
    ]);
    expect(preparedRuntimeMocks.acquired).toHaveBeenCalledExactlyOnceWith(
      preparedRuntimeMocks.captured.mock.calls[0]?.[0],
      0,
    );
    await vi.waitFor(
      () => {
        expect(broadcastToConnIds.mock.calls[0]).toEqual([
          "sessions.changed",
          expect.objectContaining({ sessionKey, reason: "create" }),
          new Set(["conn-1"]),
          { agentId: "main", dropIfSlow: true, sessionEventSubscriptionKeys: [sessionKey] },
        ]);
      },
      { timeout: 2_000, interval: 5 },
    );
  },
);
