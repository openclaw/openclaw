// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { WizardStep } from "../../api/types.ts";
import {
  createWizardTestController as createController,
  tokenStep,
} from "./wizard-controller.test-support.ts";
import { createChannelWizard } from "./wizard-runner.ts";

const selectStep = { id: "step-select", type: "select" as const };

const running = (step: WizardStep = tokenStep, sessionId?: string) => ({
  ...(sessionId ? { sessionId } : {}),
  done: false,
  status: "running",
  step,
});
const done = (
  channels = ["telegram"],
  accounts = [{ channel: "telegram", accountId: "default" }],
) => ({ done: true, status: "done", channels, accounts });
const progressStep = (id: string, message?: string) =>
  running({ id, type: "progress", executor: "gateway", message });

function replies(...steps: Array<[string, unknown]>) {
  return async (method: string) => {
    const [expected, result] = steps.shift() ?? [];
    expect(method).toBe(expected);
    if (result instanceof Error) {
      throw result;
    }
    return await result;
  };
}

const completedAccounts = [
  { channel: "telegram", accountId: "default" },
  { channel: "whatsapp", accountId: "work" },
];
const scripted = (...steps: Array<[string, unknown]>) => createController(replies(...steps));
afterEach(() => vi.useRealTimers());

it("does not treat a colliding owner selection as the channel presentation", async () => {
  const owner = running(
    {
      id: "step-owner",
      type: "select",
      message: "Set up channels for agent",
      options: [
        { value: { agentId: "telegram" }, label: "telegram" },
        { value: { agentId: "helper" }, label: "helper" },
      ],
    },
    "s-owner-collision",
  );
  const channel = running({
    id: "step-channel",
    type: "select",
    message: "Select channels",
    options: [{ value: "discord", label: "Discord" }],
  });
  const request = vi.fn(
    replies(
      ["wizard.start", owner],
      ["wizard.next", channel],
      ["wizard.next", done(["discord"], [{ channel: "discord", accountId: "default" }])],
    ),
  );
  const controller = createChannelWizard(
    () => ({ request: request as never }),
    vi.fn(),
    (value) => value === "telegram" || value === "discord",
    () => "Setup expired. Close and restart setup.",
  );

  await controller.start(null);
  await controller.answer({ agentId: "telegram" });
  await controller.answer("discord");

  expect(controller.state).toEqual({
    phase: "done",
    channel: "discord",
    channels: ["discord"],
    accounts: [{ channel: "discord", accountId: "default" }],
  });
});

it("advances gateway-owned progress without inventing user answers", async () => {
  const progress = createDeferred<unknown>();
  const { controller, request } = scripted(
    ["wizard.start", { ...progressStep("progress-1", "Starting"), sessionId: "s-progress" }],
    ["wizard.next", progress.promise],
    ["wizard.next", running()],
    ["wizard.next", progressStep("progress-3", "Finishing")],
    ["wizard.next", done(["telegram"], [])],
  );

  await controller.start("telegram");
  expect(controller.state).toMatchObject({
    phase: "step",
    step: { id: "progress-1", executor: "gateway" },
    busy: true,
  });
  expect(request).toHaveBeenLastCalledWith(
    "wizard.next",
    { sessionId: "s-progress" },
    { timeoutMs: null, signal: expect.any(AbortSignal) },
  );

  await controller.answer(null);
  expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(1);

  progress.resolve(progressStep("progress-2", "Downloading"));
  await vi.waitFor(() =>
    expect(controller.state).toMatchObject({ phase: "step", step: { id: "step-token" } }),
  );

  await controller.answer("secret-token");
  await vi.waitFor(() =>
    expect(controller.state).toMatchObject({ phase: "done", channels: ["telegram"] }),
  );

  const poll = [
    "wizard.next",
    { sessionId: "s-progress" },
    { timeoutMs: null, signal: expect.any(AbortSignal) },
  ];
  expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toEqual([
    poll,
    poll,
    [
      "wizard.next",
      { sessionId: "s-progress", answer: { stepId: "step-token", value: "secret-token" } },
    ],
    poll,
  ]);
});

it("ignores a gateway progress response after the wizard is cancelled", async () => {
  const progress = createDeferred<unknown>();
  let progressSignal: AbortSignal | undefined;
  const { controller, request, onChange } = createController(async (method, _params, options) => {
    if (method === "wizard.start") {
      return running(
        { id: "progress", type: "progress", executor: "gateway" },
        "s-progress-cancel",
      );
    }
    if (method === "wizard.next") {
      progressSignal = options?.signal;
      return await progress.promise;
    }
    return { status: "cancelled" };
  });

  await controller.start("telegram");
  await controller.cancel();
  const changeCountAfterCancel = onChange.mock.calls.length;
  progress.resolve(running());
  await Promise.resolve();
  await Promise.resolve();

  expect(controller.state).toEqual({ phase: "idle" });
  expect(progressSignal?.aborted).toBe(true);
  expect(onChange).toHaveBeenCalledTimes(changeCountAfterCancel);
  expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(1);
  expect(request).toHaveBeenCalledWith("wizard.cancel", {
    sessionId: "s-progress-cancel",
    closeInput: true,
  });
});

it("surfaces validation errors on the re-emitted step", async () => {
  const { controller } = scripted(
    ["wizard.start", running(tokenStep, "s1")],
    ["wizard.next", { ...running(), error: "Token looks invalid." }],
  );

  await controller.start("telegram");
  await controller.answer("nope");
  expect(controller.state).toMatchObject({
    phase: "step",
    validationError: "Token looks invalid.",
    busy: false,
  });
});

it.each([
  {
    name: "expired session",
    error: new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "wizard not found",
      details: { code: "WIZARD_NOT_FOUND" },
    }),
    message: "Setup expired. Close and restart setup.",
    cancellable: false,
  },
  {
    name: "generic request error",
    error: new Error("wizard unavailable"),
    message: "wizard unavailable",
    cancellable: true,
  },
])(
  "reports $name without replay and preserves its cancellation policy",
  async ({ error, message, cancellable }) => {
    const { controller, request } = scripted(
      ["wizard.start", running(tokenStep, "s1")],
      ["wizard.next", error],
      ["wizard.cancel", { status: "cancelled" }],
    );
    await controller.start("telegram");
    await controller.answer("secret-token");
    expect(controller.state).toEqual({ phase: "error", channel: "telegram", message });
    await controller.cancel();
    expect(request.mock.calls).toEqual([
      ["wizard.start", { flow: "channels", channel: "telegram" }],
      ["wizard.next", { sessionId: "s1", answer: { stepId: "step-token", value: "secret-token" } }],
      ...(cancellable ? [["wizard.cancel", { sessionId: "s1", closeInput: true }]] : []),
    ]);
  },
);

it("maps runner failures to the error phase", async () => {
  const { controller } = scripted([
    "wizard.start",
    { sessionId: "s1", done: true, status: "error", error: "config invalid" },
  ]);

  await controller.start(null);
  expect(controller.state).toEqual({
    phase: "error",
    channel: null,
    message: "config invalid",
  });
});

it("cancels a stale in-flight start so the gateway session is not leaked", async () => {
  const startResult = createDeferred<unknown>();
  const { controller, request } = scripted(
    ["wizard.start", startResult.promise],
    ["wizard.cancel", { status: "cancelled" }],
  );

  const start = controller.start("telegram");
  await Promise.resolve();
  await controller.cancel();
  startResult.resolve(running(selectStep, "s-stale"));
  await start;
  await Promise.resolve();
  expect(controller.state).toEqual({ phase: "idle" });
  expect(request).toHaveBeenCalledWith("wizard.cancel", { sessionId: "s-stale" });
});

it("cancels a session created after a local start timeout so retry can proceed", async () => {
  vi.useFakeTimers();
  const firstStartResult = createDeferred<unknown>();
  let runningSession: string | null = null;
  let startCount = 0;
  const { controller, request } = createController(async (method, params) => {
    if (method === "wizard.start") {
      startCount += 1;
      if (startCount === 1) {
        runningSession = "s-timeout";
        return await firstStartResult.promise;
      }
      if (runningSession) {
        throw new Error("wizard already running");
      }
      return running(selectStep, "s-retry");
    }
    if (method === "wizard.cancel") {
      const sessionId = (params as { sessionId?: string }).sessionId;
      if (sessionId === runningSession) {
        runningSession = null;
      }
      return { status: "cancelled" };
    }
    throw new Error(`unexpected ${method}`);
  });

  const timedOutStart = controller.start("telegram");
  await vi.advanceTimersByTimeAsync(120_000);
  await timedOutStart;
  expect(controller.state).toMatchObject({
    phase: "error",
    message: "wizard request timed out: wizard.start",
  });

  firstStartResult.resolve(running(selectStep, "s-timeout"));
  await Promise.resolve();
  await Promise.resolve();
  expect(request).toHaveBeenCalledWith("wizard.cancel", { sessionId: "s-timeout" });
  expect(runningSession).toBeNull();

  await controller.start("telegram");
  expect(startCount).toBe(2);
  expect(controller.state).toMatchObject({
    phase: "step",
    step: { id: "step-select" },
    busy: false,
  });
});

it("does not cancel a terminal start result that arrives after the local timeout", async () => {
  vi.useFakeTimers();
  const startResult = createDeferred<unknown>();
  const { controller, request } = scripted(
    ["wizard.start", startResult.promise],
    ["wizard.cancel", { status: "cancelled" }],
  );

  const timedOutStart = controller.start("telegram");
  await vi.advanceTimersByTimeAsync(120_000);
  await timedOutStart;

  startResult.resolve({ sessionId: "s-done", done: true, status: "done" });
  await Promise.resolve();
  await Promise.resolve();

  expect(request.mock.calls.filter(([method]) => method === "wizard.cancel")).toEqual([]);
});

it.each([
  {
    name: "gateway-reported channels",
    initial: null,
    answer: "whatsapp",
    result: done(["telegram", "whatsapp"], structuredClone(completedAccounts)),
    expected: {
      phase: "done",
      channel: "telegram",
      channels: ["telegram", "whatsapp"],
      accounts: completedAccounts,
    },
  },
  {
    name: "no configured channels",
    initial: "whatsapp",
    answer: "__skip__",
    result: { done: true, status: "done" },
    expected: { phase: "done", channel: "whatsapp", channels: [], accounts: [] },
  },
])("completes with $name", async ({ initial, answer, result, expected }) => {
  const { controller } = scripted(
    ["wizard.start", running(selectStep, "s1")],
    ["wizard.next", result],
  );
  await controller.start(initial);
  await controller.answer(answer);
  expect(controller.state).toEqual(expected);
});

it("ignores answers while a previous answer is in flight", async () => {
  const nextResult = createDeferred<unknown>();
  const { controller, request } = scripted(
    ["wizard.start", running(selectStep, "s1")],
    ["wizard.next", nextResult.promise],
  );

  await controller.start("telegram");
  const first = controller.answer("telegram");
  await Promise.resolve();
  await controller.answer("again");
  expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(1);
  nextResult.resolve(done());
  await first;
  expect(controller.state).toEqual({
    phase: "done",
    channel: "telegram",
    channels: ["telegram"],
    accounts: [{ channel: "telegram", accountId: "default" }],
  });
});
