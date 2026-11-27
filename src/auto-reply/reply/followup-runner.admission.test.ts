import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { readPreparedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createOperatorRecoveryFixture,
  pairedOperator,
} from "../../gateway/operator-run-recovery.test-support.js";
import { createContext } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareChannelRunAdmission } from "./channel-run-admission.js";
import type { FollowupExecutionResult } from "./followup-turn-execution.js";
import { enqueueFollowupRun, type FollowupRun } from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import type { FollowupRunnerParams } from "./reply-agent-turn-preparation.js";

const state = vi.hoisted(() => ({
  account: vi.fn<typeof import("./agent-runner-result-accounting.js").accountFollowupTurn>(),
  deliver: vi.fn<typeof import("./followup-delivery.js").deliverFollowupDecision>(),
  execute: vi.fn<typeof import("./followup-turn-execution.js").executeFollowupTurn>(),
  preflight: vi.fn<typeof import("./agent-runner-memory.js").runSessionCompactionIfNeeded>(),
  resolveDecision: vi.fn<typeof import("./followup-delivery.js").resolveFollowupDeliveryDecision>(),
}));

vi.mock("./agent-runner-memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-memory.js")>()),
  runMemoryFlushIfNeeded: vi.fn(),
  runSessionCompactionIfNeeded: state.preflight,
}));

vi.mock("./agent-runner-result-accounting.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-result-accounting.js")>()),
  accountFollowupTurn: state.account,
}));

vi.mock("./followup-delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./followup-delivery.js")>()),
  deliverFollowupDecision: state.deliver,
  resolveFollowupDeliveryDecision: state.resolveDecision,
}));

vi.mock("./followup-turn-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./followup-turn-execution.js")>()),
  executeFollowupTurn: state.execute,
}));

// mock-isolation: Exercise queue admission and source acceptance without starting a model runtime.
vi.mock("./agent-runner-execution.js", () => ({
  executeAgentTurn: async () => createSettledExecution().execution,
}));

const { createFollowupRunner } = await import("./followup-runner.js");

function createQueuedRun(sessionKey: string): FollowupRun {
  const queued = createQueueTestRun({ prompt: "queued prompt" });
  Object.assign(queued.run, {
    agentId: "main",
    sessionId: `${sessionKey}-session`,
    sessionKey,
    provider: "anthropic",
    model: "claude",
  });
  return queued;
}

function createSettledExecution(): FollowupExecutionResult {
  return {
    commentaryPayloadsEnabled: false,
    execution: {
      runId: "followup-run",
      outcome: {
        kind: "settled",
        status: "ok",
        result: { payloads: [], meta: { durationMs: 0 } },
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        autoCompactionCount: 0,
      },
    },
    runStartedAt: 1,
    sessionCtx: {},
    pendingToolTasks: new Set(),
    progress: { drain: vi.fn(async () => {}) },
  };
}

const activeKeys = new Set<string>();

async function drain(queued: FollowupRun, overrides: Partial<FollowupRunnerParams> = {}) {
  const sessionKey = queued.run.sessionKey!;
  activeKeys.add(sessionKey);
  const completed = createDeferred();
  const runner = createFollowupRunner({
    typingMode: "never",
    defaultModel: "anthropic/claude",
    ...overrides,
  });
  expect(
    enqueueFollowupRun(
      sessionKey,
      queued,
      { mode: "followup", debounceMs: 0 },
      "none",
      async (run) => {
        await runner(run);
        completed.resolve();
      },
    ),
  ).toBe(true);
  await completed.promise;
  expect(getSessionControllerOperation(sessionKey)).toBeUndefined();
}

afterEach(async () => {
  for (const key of activeKeys) {
    const operation = getSessionControllerOperation(key);
    operation?.complete();
    await operation?.ownerSettlement;
  }
  activeKeys.clear();
});

beforeEach(() => {
  vi.clearAllMocks();
  state.account.mockResolvedValue(undefined);
  state.execute.mockResolvedValue(createSettledExecution());
  state.preflight.mockImplementation(async (params) => params.sessionEntry);
  state.resolveDecision.mockResolvedValue({ kind: "suppress", reason: "silent" });
  state.deliver.mockResolvedValue({ kind: "completed", payloads: [] });
});

async function runPolicyRefreshScenario(sessionKey: string, refreshedPolicy: "allow" | "deny") {
  const sessionEntry: InternalSessionEntry = {
    sessionId: `${sessionKey}-session`,
    updatedAt: Date.now(),
    sendPolicy: "allow",
  };
  const queued = createQueuedRun(sessionKey);
  queued.run.sessionId = sessionEntry.sessionId;
  queued.run.config = { agents: { defaults: { compaction: { notifyUser: true } } } };
  state.preflight.mockImplementation(async (input) => {
    await input.onCompactionNotice?.("end", "Context compacted");
    sessionEntry.sendPolicy = refreshedPolicy;
    return sessionEntry;
  });
  await drain(queued, {
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
  });
}

it("releases the admitted operation when source adoption fails", async () => {
  const { executeFollowupTurn } = await vi.importActual<
    typeof import("./followup-turn-execution.js")
  >("./followup-turn-execution.js");
  state.execute.mockImplementation(executeFollowupTurn);
  const sessionKey = "agent:main:followup-adoption-failure";
  const queued = createQueuedRun(sessionKey);
  const failure = new Error("source adoption failed");
  const onAdopted = vi.fn().mockRejectedValue(failure);
  queued.turnAdoptionLifecycle = { onAdopted };
  await drain(queued);
  expect(state.execute).toHaveBeenCalledOnce();
  expect(onAdopted).toHaveBeenCalledOnce();
});

it("suppresses a deferred compaction notice after preflight refreshes policy to deny", async () => {
  await runPolicyRefreshScenario("agent:main:followup-policy-control", "allow");
  expect(state.deliver.mock.calls.filter(([params]) => params.kind === "block")).toHaveLength(1);

  state.deliver.mockClear();
  state.execute.mockClear();
  await runPolicyRefreshScenario("agent:main:followup-policy-refresh", "deny");
  expect(state.deliver.mock.calls.filter(([params]) => params.kind === "block")).toHaveLength(0);
  expect(state.execute).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "prepares queued execution with current requester scopes (narrowed=%s)",
  async (narrowed) => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async ({ stateDir }) => {
        const profile = ensureProfileForEmail("followup-scope@example.test");
        const config: OpenClawConfig = {
          gateway: {
            roles: {
              default: "writer",
              definitions: {
                writer: { agents: "*", scopes: ["operator.write"], sessions: { others: "write" } },
                restricted: {
                  agents: "*",
                  scopes: ["operator.sessions.write"],
                  sessions: { others: "write" },
                },
              },
            },
          },
        };
        setRuntimeConfigSnapshot(config);
        const fixture = await createOperatorRecoveryFixture({
          stateDir,
          context: createContext(),
          profileId: profile.id,
          config,
          sessionKey: "agent:main:followup-current-scopes",
          scopes: ["operator.write"],
          device: pairedOperator(),
        });
        const source = await fixture.restore();
        const write = vi.fn();
        const queued = createQueuedRun(fixture.target.sessionKey);
        queued.operatorAuthority = source.authority;
        queued.run.config = config;
        queued.run.sessionId = fixture.target.sessionId;
        if (narrowed) {
          setUserProfileRole(profile.id, "restricted");
        }
        state.execute.mockImplementation(async ({ turn }) => {
          const prepared = prepareChannelRunAdmission({
            cfg: turn.config,
            runId: turn.runId,
            agentId: turn.queued.run.agentId,
            ingressKind: "channel",
            boundary: "auto-reply.agent-runner",
            operatorAuthority: turn.queued.operatorAuthority,
          });
          try {
            const authority = readPreparedRunOperatorAuthority(prepared);
            if (
              roleScopesAllow({
                role: "operator",
                requestedScopes: ["operator.write"],
                allowedScopes: authority?.scopes ?? [],
              })
            ) {
              write();
            }
          } finally {
            prepared.close();
          }
          return createSettledExecution();
        });
        try {
          await drain(queued, {
            resolveGatewayContext: () => fixture.context,
            sessionEntry: fixture.entry,
            sessionStore: { [fixture.target.sessionKey]: fixture.entry },
          });
          expect(state.execute).toHaveBeenCalledOnce();
          expect(write).toHaveBeenCalledTimes(narrowed ? 0 : 1);
        } finally {
          source.release();
        }
      },
    );
  },
);
