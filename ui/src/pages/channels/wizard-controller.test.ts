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
const startThen = (...results: unknown[]) =>
  scripted(
    ...results.map((result, index): [string, unknown] => [
      index ? "wizard.next" : "wizard.start",
      result,
    ]),
  );
const finished = (channel = "telegram", channels = [channel], accounts = done().accounts) => ({
  phase: "done",
  channel,
  channels,
  accounts,
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

it("does not treat a colliding owner selection as the channel presentation", async () => {
  const owner = running(
    {
      id: "step-owner",
      type: "select",
      message: "Set up channels for agent",
      options: ["telegram", "helper"].map((agentId) => ({ value: { agentId }, label: agentId })),
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

  expect(controller.state).toEqual(
    finished("discord", ["discord"], [{ channel: "discord", accountId: "default" }]),
  );
});

it("advances gateway-owned progress without inventing user answers", async () => {
  const progress = createDeferred<unknown>();
  const { controller, request } = startThen(
    { ...progressStep("progress-1", "Starting"), sessionId: "s-progress" },
    progress.promise,
    running(),
    progressStep("progress-3", "Finishing"),
    done(["telegram"], []),
  );

  await controller.start("telegram");
  expect(controller.state).toMatchObject({
    phase: "step",
    step: { id: "progress-1", executor: "gateway" },
    busy: true,
  });
  const poll = [
    "wizard.next",
    { sessionId: "s-progress" },
    { timeoutMs: null, signal: expect.any(AbortSignal) },
  ];
  expect(request).toHaveBeenLastCalledWith(...poll);

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
  await settle();

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
  const { controller } = startThen(running(tokenStep, "s1"), {
    ...running(),
    error: "Token looks invalid.",
  });

  await controller.start("telegram");
  await controller.answer("nope");
  expect(controller.state).toMatchObject({
    phase: "step",
    validationError: "Token looks invalid.",
    busy: false,
  });
});

it.each([
  [
    "expired session",
    new GatewayRequestError({
      code: "INVALID_REQUEST",
      message: "wizard not found",
      details: { code: "WIZARD_NOT_FOUND" },
    }),
    "Setup expired. Close and restart setup.",
    false,
  ],
  ["generic request error", new Error("wizard unavailable"), "wizard unavailable", true],
] as const)(
  "reports %s without replay and preserves its cancellation policy",
  async (_name, error, message, cancellable) => {
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
  const { controller } = startThen({
    sessionId: "s1",
    done: true,
    status: "error",
    error: "config invalid",
  });

  await controller.start(null);
  expect(controller.state).toEqual({ phase: "error", channel: null, message: "config invalid" });
});

it.each(["cancel", "timeout", "terminal"] as const)(
  "settles a late start after %s without leaking a live session",
  async (mode) => {
    vi.useFakeTimers();
    const pending = createDeferred<unknown>();
    let session: string | null = null;
    let starts = 0;
    const { controller, request } = createController(async (method, params) => {
      if (method === "wizard.cancel") {
        if ((params as { sessionId: string }).sessionId === session) {
          session = null;
        }
        return { status: "cancelled" };
      }
      if (method !== "wizard.start") {
        throw new Error(`unexpected ${method}`);
      }
      if (++starts === 1) {
        session = "late";
        return await pending.promise;
      }
      if (session) {
        throw new Error("wizard already running");
      }
      return running(selectStep, "retry");
    });
    const start = controller.start("telegram");
    if (mode === "cancel") {
      await Promise.resolve();
      await controller.cancel();
    } else {
      await vi.advanceTimersByTimeAsync(120_000);
      await start;
      expect(controller.state).toMatchObject({
        phase: "error",
        message: "wizard request timed out: wizard.start",
      });
    }
    pending.resolve(
      mode === "terminal" ? { ...done(), sessionId: "late" } : running(selectStep, "late"),
    );
    await start;
    await settle();
    if (mode === "terminal") {
      expect(request.mock.calls.filter(([method]) => method === "wizard.cancel")).toEqual([]);
      return;
    }
    if (mode === "cancel") {
      expect(controller.state).toEqual({ phase: "idle" });
    }
    expect(request).toHaveBeenCalledWith("wizard.cancel", { sessionId: "late" });
    expect(session).toBeNull();
    await controller.start("telegram");
    expect(starts).toBe(2);
    expect(controller.state).toMatchObject({
      phase: "step",
      step: { id: "step-select" },
      busy: false,
    });
  },
);

it.each([
  [
    "gateway-reported channels",
    null,
    "whatsapp",
    done(["telegram", "whatsapp"], structuredClone(completedAccounts)),
    finished("telegram", ["telegram", "whatsapp"], completedAccounts),
  ],
  [
    "no configured channels",
    "whatsapp",
    "__skip__",
    { done: true, status: "done" },
    finished("whatsapp", [], []),
  ],
] as const)("completes with %s", async (_name, initial, answer, result, expected) => {
  const { controller } = startThen(running(selectStep, "s1"), result);
  await controller.start(initial);
  await controller.answer(answer);
  expect(controller.state).toEqual(expected);
});

it("ignores answers while a previous answer is in flight", async () => {
  const nextResult = createDeferred<unknown>();
  const { controller, request } = startThen(running(selectStep, "s1"), nextResult.promise);

  await controller.start("telegram");
  const first = controller.answer("telegram");
  await Promise.resolve();
  await controller.answer("again");
  expect(request.mock.calls.filter(([method]) => method === "wizard.next")).toHaveLength(1);
  nextResult.resolve(done());
  await first;
  expect(controller.state).toEqual(finished());
});
