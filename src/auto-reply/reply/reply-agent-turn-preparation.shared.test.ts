import { assert, beforeEach, expect, it, vi } from "vitest";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import type { SessionControllerMailboxClaim } from "../../sessions/session-controller.mailbox.js";
import { createPreparationRun as createRun } from "./reply-agent-turn-preparation.test-support.js";

const state = vi.hoisted(() => ({
  admit: vi.fn(),
  preflight: vi.fn(),
  resolveConfig: vi.fn(async (config: unknown) => config),
}));

vi.mock("../../sessions/session-controller.mailbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-controller.mailbox.js")>()),
  attachSessionControllerInputOperation: vi.fn(),
  bindSessionControllerInputOperation: vi.fn(),
  claimSessionControllerInput: vi.fn(),
  releaseSessionControllerClaim: vi.fn(),
}));
vi.mock("./agent-runner-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-utils.js")>()),
  resolveQueuedReplyExecutionConfig: (config: unknown) => state.resolveConfig(config),
}));
vi.mock("./reply-turn-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reply-turn-admission.js")>()),
  admitReplyTurn: state.admit,
}));
vi.mock("./agent-runner-memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-memory.js")>()),
  runSessionCompactionIfNeeded: state.preflight,
}));

const { prepareReplyAgentTurn } = await import("./reply-agent-turn-preparation.js");
const { reserveSessionControllerSource, retireSessionControllerInput } =
  await import("../../sessions/session-controller.mailbox.js");

function createOperation() {
  const operation = {
    sessionId: "session",
    abortSignal: new AbortController().signal,
    fail: vi.fn(),
    complete: vi.fn(),
    updateSessionId: vi.fn(),
  };
  return { operation: operation as unknown as ReplyOperation, spies: operation };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.admit.mockImplementation(async () => ({
    status: "owned",
    operation: createOperation().operation,
  }));
  state.preflight.mockResolvedValue(undefined);
});

type Turn = Parameters<typeof prepareReplyAgentTurn>[0];
type PrepareOptions = Partial<Omit<Turn, "defaults">> & { opts?: Turn["defaults"]["opts"] };
function prepare({ opts, ...params }: PrepareOptions = {}) {
  return prepareReplyAgentTurn({
    queued: createRun(),
    claimSource: async () =>
      ({ abortController: new AbortController() }) as SessionControllerMailboxClaim,
    ...params,
    defaults: {
      typing: {} as Turn["defaults"]["typing"],
      typingMode: "never",
      defaultModel: "default-model",
      opts,
    },
  });
}

it("prepares immediate and queued turns through the same model and memory preflight", async () => {
  const signalRunStart = vi.fn(async () => {});
  for (const kind of ["visible", "queued_followup"] as const) {
    const result = await prepare({ kind, signalRunStart });
    expect(result.kind).toBe("admitted");
  }
  expect(state.resolveConfig).toHaveBeenCalledTimes(2);
  expect(signalRunStart).toHaveBeenCalledTimes(2);
  expect(state.preflight.mock.calls.map(([params]) => params.defaultModel)).toEqual([
    "default-model",
    "default-model",
  ]);
});

it("gives consecutive unbound queued turns distinct execution identities", async () => {
  const opts = { runId: "immediate" };
  const runIds: string[] = [];
  for (let index = 0; index < 2; index++) {
    const result = await prepare({ opts, kind: "queued_followup" });
    assert(result.kind === "admitted", "Expected queued turn admission");
    runIds.push(result.turn.runId);
    expect(result.turn.runId).not.toBe(opts.runId);
  }
  expect(runIds[0]).not.toBe(runIds[1]);
  expect(state.preflight.mock.calls.map(([params]) => params.opts.runId)).toEqual(runIds);
});

it.each(["visible", "queued_followup"] as const)(
  "preserves an explicit protocol run identity for %s turns",
  async (kind) => {
    const input = reserveSessionControllerSource("run-identity-test", {
      protocolRunId: "protocol-turn",
      policy: { mode: "followup" },
    });
    try {
      const queued = { ...createRun(), controllerInput: input };
      const result = await prepare({ queued, opts: { runId: "immediate" }, kind });
      expect(result).toMatchObject({ kind: "admitted", turn: { runId: "protocol-turn" } });
      expect(state.preflight.mock.calls[0]?.[0].opts.runId).toBe("protocol-turn");
    } finally {
      retireSessionControllerInput(input);
    }
  },
);

it.each([null, "aborted_by_user", "aborted_for_restart"] as const)(
  "settles rejected admission once without replacing %s",
  async (code) => {
    const { operation, spies } = createOperation();
    Object.defineProperty(operation, "result", {
      value: code ? { kind: "aborted", code } : null,
    });
    state.admit.mockResolvedValue({ status: "owned", operation });
    const failure = new Error("source adoption failed");
    const settled = vi.fn(async () => {});

    await expect(
      prepare({
        opts: {
          onQueuedFollowupAdmitted: vi.fn().mockRejectedValue(failure),
          onQueuedFollowupSettled: settled,
        },
      }),
    ).rejects.toBe(failure);

    expect(settled).toHaveBeenCalledOnce();
    expect(spies.complete).toHaveBeenCalledOnce();
    if (code) {
      expect(spies.fail).not.toHaveBeenCalled();
      expect(operation.result).toEqual({ kind: "aborted", code });
    } else {
      expect(spies.fail).toHaveBeenCalledExactlyOnceWith("run_failed", failure);
    }
    expect(state.preflight).not.toHaveBeenCalled();
  },
);
