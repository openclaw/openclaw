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
  advanceAndFlush as advance,
  expectBroadcast,
  useObserverSuite,
} from "./session-observer-suite.test-support.js";
import {
  event,
  modelMessage,
  preparedModel,
  startAndAddToolNotes,
} from "./session-observer.test-utils.js";

const { createHarness } = useObserverSuite();

beforeEach(() => {
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
  resetSecretRedactionRegistryForTest();
  setCurrentPluginMetadataSnapshot(undefined);
});

it.each(["exact tool cap", "invalid schema", "manifest alias"])(
  "warns once when %s failures disable observation, and retries on the next run",
  async (failure) => {
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
      await advance(24_000);
      expect(notices).toMatchObject([
        {
          runId: "run-1",
          sessionKey: "agent:main:session-1",
          data: {
            phase: "warning",
            message: expect.stringMatching(
              /openai\/gpt-test.*choose a capable utility model.*utilityModel\.fallbacks/u,
            ),
          },
        },
      ]);
      expect(notices[0]?.data.message).not.toMatch(
        /private-profile|private-utility-alias|private-manifest-alias/u,
      );
      const callsAtDisable = prepareModel.mock.calls.length + completeModel.mock.calls.length;
      await harness.observer.handleEventAsync(
        event({ stream: "tool", data: { phase: "start", name: "read", args: { path: "more" } } }),
      );
      await advance(60_000);
      expect(prepareModel.mock.calls.length + completeModel.mock.calls.length).toBe(callsAtDisable);
      expect(notices).toHaveLength(1);

      prepareModel.mockImplementation(async () => preparedModel());
      completeModel.mockImplementation(async () =>
        modelMessage({ headline: "Working", health: "on-track" }),
      );
      await startAndAddToolNotes(harness.observer, { runId: "run-2" });
      await advance(12_000);
      expectBroadcast(harness, { runId: "run-2", headline: "Working" });
      expect(notices).toHaveLength(1);
    } finally {
      unsubscribe();
      await harness.observer.disposeAsync();
      releaseAgentRunContext("run-1", owner);
    }
  },
);

function completionAfter(delay?: number) {
  return vi.fn(
    (params: { abortSignal?: AbortSignal }) =>
      new Promise<ReturnType<typeof modelMessage>>((resolve, reject) => {
        params.abortSignal!.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        if (delay !== undefined) {
          setTimeout(
            () => resolve(modelMessage({ headline: "Working", health: "on-track" })),
            delay,
          );
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
  const completeModel = completionAfter(15_000);
  const harness = createHarness({ completeModel });
  await startAndAddToolNotes(harness.observer);

  await advance(12_000);
  expect(completeModel).toHaveBeenCalledOnce();
  await advance(15_000);

  expect(completeModel.mock.calls[0]?.[0].abortSignal?.aborted).toBe(false);
  expectBroadcast(harness, { headline: "Working", health: "on-track" });
});

it("aborts stuck completions at the cap and disables the run after two failures", async () => {
  const completeModel = completionAfter();
  const signal = (index: number) => completeModel.mock.calls[index]?.[0].abortSignal;
  const harness = createHarness({ completeModel });
  await startAndAddToolNotes(harness.observer);
  await advance(12_000);
  await advance(29_999);
  expect(signal(0)?.aborted).toBe(false);
  await advance(1);
  expect(signal(0)?.aborted).toBe(true);
  expect(completeModel).toHaveBeenCalledTimes(2);
  await advance(30_000);
  expect(signal(1)?.aborted).toBe(true);
  await advance(60_000);
  expect(completeModel).toHaveBeenCalledTimes(2);
  expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
});
