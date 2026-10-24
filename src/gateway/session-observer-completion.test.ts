import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createSessionObserverCompletion } from "./session-observer-completion.js";
import type { defaultCompleteModel } from "./session-observer-model.js";
import { observerState } from "./session-observer-state.test-support.js";
import {
  createHarness,
  event,
  flushObserver,
  modelMessage,
  preparedModel,
  resetSessionObserverEventSequence,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

beforeEach(() => {
  vi.useFakeTimers();
  setGatewayPluginMetadataSnapshot(
    createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "openai",
          modelIdNormalization: {
            providers: { openai: { aliases: { "private-manifest-alias": "gpt-test" } } },
          },
        },
      ],
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  resetSessionObserverEventSequence();
  resetSecretRedactionRegistryForTest();
  setCurrentPluginMetadataSnapshot(undefined);
});

it.each(["exact tool cap", "invalid schema", "manifest alias"])(
  "warns once when %s failures disable observation, and retries on the next run",
  async (failure) => {
    vi.setSystemTime(0);
    const notices: AgentEventPayload[] = [];
    const unsubscribe = onAgentEvent((evt) => {
      if (evt.stream === "notice") {
        notices.push(evt);
      }
    });
    const prepareModel = vi.fn(async () => {
      if (failure === "exact tool cap") {
        throw new Error('CLI backend "test-cli" cannot enforce this run\'s tool cap.');
      }
      return preparedModel();
    });
    const completeModel = vi.fn(async () =>
      modelMessage({ headline: "Working", health: "on-track", planProgress: null }),
    );
    const harness = createHarness({
      prepareModel,
      completeModel,
      config: {
        gateway: { controlUi: { sessionObserver: true } },
        agents: {
          defaults: {
            utilityModel:
              failure === "manifest alias"
                ? "openai/private-manifest-alias@private-profile"
                : failure === "exact tool cap"
                  ? "openai/gpt-test@private-profile"
                  : "private-utility-alias@private-profile",
            models: { "openai/gpt-test": { alias: "private-utility-alias" } },
          },
        },
      },
    });
    const owner = claimAgentRunContext(
      "run-1",
      { sessionKey: "agent:main:session-1", agentId: "main" },
      { exclusive: true },
    );
    try {
      await startAndAddToolNotes(harness.observer);
      await vi.advanceTimersByTimeAsync(24_000);
      await flushObserver();
      expect(notices).toMatchObject([
        {
          runId: "run-1",
          sessionKey: "agent:main:session-1",
          data: {
            phase: "warning",
            message: expect.stringContaining("openai/gpt-test"),
          },
        },
      ]);
      expect(notices[0]?.data.message).toContain("choose a capable utility model");
      expect(notices[0]?.data.message).toContain("utilityModel.fallbacks");
      expect(notices[0]?.data.message).not.toContain("private-profile");
      expect(notices[0]?.data.message).not.toContain("private-utility-alias");
      expect(notices[0]?.data.message).not.toContain("private-manifest-alias");
      const callsAtDisable = prepareModel.mock.calls.length + completeModel.mock.calls.length;
      await harness.observer.handleEventAsync(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { path: "more" } } }),
      );
      await vi.advanceTimersByTimeAsync(60_000);
      await flushObserver();
      expect(prepareModel.mock.calls.length + completeModel.mock.calls.length).toBe(callsAtDisable);
      expect(notices).toHaveLength(1);

      prepareModel.mockImplementation(async () => preparedModel());
      completeModel.mockImplementation(async () =>
        modelMessage({ headline: "Working", health: "on-track" }),
      );
      await startAndAddToolNotes(harness.observer, { runId: "run-2" });
      await vi.advanceTimersByTimeAsync(12_000);
      await flushObserver();
      expect(harness.broadcastToConnIds).toHaveBeenCalledWith(
        "session.observer",
        expect.objectContaining({ runId: "run-2", headline: "Working" }),
        expect.any(Set),
        expect.anything(),
      );
      expect(notices).toHaveLength(1);
    } finally {
      unsubscribe();
      await harness.observer.disposeAsync();
      releaseAgentRunContext("run-1", owner);
    }
  },
);

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
    .fn<typeof defaultCompleteModel>()
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
  await flushObserver();
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
  await flushObserver();
  await vi.advanceTimersByTimeAsync(29_999);
  await flushObserver();
  expect(signal(0)?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await flushObserver();
  expect(signal(0)?.aborted).toBe(true);
  expect(completeModel).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(30_000);
  await flushObserver();
  expect(signal(1)?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  await flushObserver();
  expect(completeModel).toHaveBeenCalledTimes(2);
  expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
  await harness.observer.disposeAsync();
});
