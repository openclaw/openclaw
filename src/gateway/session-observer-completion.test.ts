import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { createSessionObserverCompletion } from "./session-observer-completion.js";
import type { SessionObserverDeps } from "./session-observer-model.js";
import { observerState } from "./session-observer-state.test-support.js";
import {
  createHarness,
  flushObserver,
  modelMessage,
  preparedModel,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

beforeEach(() => vi.useFakeTimers());

afterEach(() => {
  vi.useRealTimers();
  resetSessionObserverEventSequence();
  resetSecretRedactionRegistryForTest();
});

function completionAfter(delay?: number) {
  const reply = modelMessage({
    headline: "Reviewing the implementation",
    assessment: "The work is progressing steadily.",
    health: "on-track",
  });
  return vi.fn(
    (params: { abortSignal?: AbortSignal }) =>
      new Promise<ReturnType<typeof modelMessage>>((resolve, reject) => {
        params.abortSignal!.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        if (delay !== undefined) {
          setTimeout(() => resolve(reply), delay);
        }
      }),
  );
}

it("reports a redacted, collapsed, bounded prefix of the last of two rejected replies", async () => {
  const password = `synthetic-${"x".repeat(200)}-credential`;
  const registered = `registered-${"q".repeat(200)}-fixture`;
  registerSecretValueForRedaction(registered);
  const result = { ...modelMessage({}), text: "first rejected output" };
  const completeModel = vi
    .fn<NonNullable<SessionObserverDeps["completeModel"]>>()
    .mockResolvedValueOnce(result)
    .mockResolvedValueOnce({
      ...result,
      text: ` \n last\t rejected\noutput ${registered} password=${password}\n${"x".repeat(180)} `,
    });
  const request = createSessionObserverCompletion({
    getConfig: () => ({}),
    prepareModel: vi.fn(async () => ({ ...preparedModel(), config: {} })),
    completeModel,
    isCurrent: () => true,
  });
  const error = await request(observerState(), []).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  const heading = "session observer returned invalid JSON twice; last rejected output: ";
  expect(message).toContain(heading);
  const prefix = message.slice(heading.length);
  expect(prefix).toHaveLength(160);
  expect(prefix).toContain("last rejected output ");
  expect(prefix).not.toMatch(/[\n\r\t]/u);
  expect(prefix).not.toContain(registered.slice(0, 64));
  expect(prefix).not.toContain(password.slice(0, 64));
  expect(prefix).toContain("password=");
  expect(prefix).toMatch(/x{20}$/u);
  expect(completeModel).toHaveBeenCalledTimes(2);
});

it("publishes a digest from a utility model that answers after 15s", async () => {
  vi.setSystemTime(0);
  // CLI-backed utility models (for example claude-cli Haiku) take 9-16s per call.
  const completeModel = completionAfter(15_000);
  const harness = createHarness({ completeModel });
  await startAndAddToolNotes(harness.observer);

  await vi.advanceTimersByTimeAsync(12_000);
  expect(completeModel).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(15_000);
  await flushObserver();

  expect(completeModel.mock.calls[0]?.[0].abortSignal?.aborted).toBe(false);
  expect(harness.broadcastToConnIds).toHaveBeenCalledWith(
    "session.observer",
    expect.objectContaining({ headline: "Reviewing the implementation", health: "on-track" }),
    expect.any(Set),
    expect.anything(),
  );
  await harness.observer.disposeAsync();
});

it("aborts stuck completions at the cap and disables the run after two failures", async () => {
  vi.setSystemTime(0);
  const completeModel = completionAfter();
  const signal = (index: number) => completeModel.mock.calls[index]?.[0].abortSignal;
  const harness = createHarness({ completeModel });
  await startAndAddToolNotes(harness.observer);
  await vi.advanceTimersByTimeAsync(12_000);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(signal(0)?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(signal(0)?.aborted).toBe(true);
  expect(completeModel).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(signal(1)?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(completeModel).toHaveBeenCalledTimes(2);
  expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
  await harness.observer.disposeAsync();
});
