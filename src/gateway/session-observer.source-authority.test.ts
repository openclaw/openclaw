import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as observerWork from "./session-observer-work.js";
import {
  createHarness,
  event,
  modelMessage,
  preparedModel,
  resetSessionObserverEventSequence,
} from "./session-observer.test-utils.js";

it("queues background digest persistence after its publisher and joins it before disposal", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const options = { agentId: "main", path: state.path("sessions.sqlite"), env: state.env };
    const entered = createDeferred();
    const release = createDeferred();
    const order: string[] = [];
    let digestEntered = false;
    const persistDigest = vi.fn(() =>
      runOpenClawAgentWorkerWrite(options, async () => {
        digestEntered = true;
        entered.resolve();
        await release.promise;
        order.push("persisted");
        return true;
      }),
    );
    const harness = createHarness({
      config: {
        session: { store: options.path },
        gateway: { controlUi: { sessionObserver: true } },
      },
      utilityModelRef: null,
      persistDigest,
    });
    let successor: Promise<void> | undefined;
    let disposal: Promise<void> | undefined;
    try {
      await runOpenClawAgentWriteAdmission(options, async () => {
        harness.observer.handleEvent(
          event({ stream: "item", data: { kind: "preamble", progressText: "Reviewing" } }),
        );
        expect(persistDigest).toHaveBeenCalledOnce();
        expect(digestEntered).toBe(false);
      });
      await withinTest(entered.promise, signal);
      successor = runOpenClawAgentWriteAdmission(options, () =>
        runOpenClawAgentWorkerWrite(options, async () => {
          order.push("successor");
        }),
      );
      disposal = harness.observer.disposeAsync().then(() => {
        order.push("disposed");
      });
      release.resolve();
      await withinTest(Promise.all([successor, disposal]), signal);
      expect(order[0]).toBe("persisted");
      expect(order).toHaveLength(3);
    } finally {
      release.resolve();
      await Promise.allSettled([successor, disposal]);
      await harness.observer.disposeAsync();
      resetSessionObserverEventSequence();
    }
  });
});

it.for(["model", "failed model", "synthesized terminal"] as const)(
  "rechecks physical source authority before consuming a %s digest",
  async (kind, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const config: OpenClawConfig = {
        session: { store: state.path("original.sqlite") },
        gateway: { controlUi: { sessionObserver: true } },
        agents: { defaults: { utilityModel: "openai/gpt-test" } },
      };
      const replacementStore = state.path("replacement.sqlite");
      let changeSourceOnRead = false;
      let sourceChanges = 0;
      let backgroundRegistrations = 0;
      let backgroundFinished = createDeferred();
      const backgroundSettlements: Promise<void>[] = [];
      const createWork = observerWork.createSessionObserverWork;
      const factory = vi
        .spyOn(observerWork, "createSessionObserverWork")
        .mockImplementation((params) => {
          const work = createWork(params);
          const withCurrent = work.withCurrent.bind(work);
          vi.spyOn(work, "withCurrent").mockImplementation((...args) => {
            if (changeSourceOnRead) {
              changeSourceOnRead = false;
              config.session = { store: replacementStore };
              sourceChanges += 1;
            }
            return withCurrent(...args);
          });
          const background = work.background.bind(work);
          vi.spyOn(work, "background").mockImplementation((run) => {
            backgroundRegistrations += 1;
            const finished = backgroundFinished;
            const settled = createDeferred();
            backgroundSettlements.push(settled.promise);
            background(async () => {
              try {
                return await run();
              } finally {
                finished.resolve();
                settled.resolve();
              }
            });
          });
          return work;
        });
      let harness: ReturnType<typeof createHarness> | undefined;
      try {
        harness = createHarness({
          config,
          utilityModelRef: kind === "synthesized terminal" ? null : "openai/gpt-test",
          readSession: vi.fn(() => ({
            sessionId: "session-id",
            lifecycleRevision: "owned",
            updatedAt: 1,
          })),
          prepareModel: vi.fn(async () => preparedModel()),
          completeModel: vi.fn(async () => {
            if (kind === "failed model") {
              throw new Error("model request failed");
            }
            return modelMessage({ headline: "Finished reviewing", health: "done" });
          }),
        });
        expect(factory).toHaveBeenCalledOnce();
        if (kind !== "synthesized terminal") {
          await withinTest(
            harness.observer.handleEventAsync(
              event({
                stream: "lifecycle",
                data: { phase: "start", startedAt: 0 },
              }),
            ),
            signal,
          );
          await withinTest(
            harness.observer.handleEventAsync(
              event({
                stream: "tool",
                data: { phase: "start", name: "read", args: { path: "example.ts" } },
              }),
            ),
            signal,
          );
        } else {
          await withinTest(
            harness.observer.handleEventAsync(
              event({
                stream: "item",
                data: { kind: "preamble", progressText: "Reviewing", startedAt: 0 },
              }),
            ),
            signal,
          );
          expect(backgroundRegistrations).toBe(1);
          await withinTest(backgroundFinished.promise, signal);
          expect(harness.broadcastToConnIds).toHaveBeenCalledOnce();
          expect(harness.persistDigest).toHaveBeenCalledOnce();
          harness.broadcastToConnIds.mockClear();
          harness.persistDigest.mockClear();
          backgroundFinished = createDeferred();
          backgroundRegistrations = 0;
        }
        expect(backgroundRegistrations).toBe(0);
        changeSourceOnRead = true;
        await withinTest(
          harness.observer.handleEventAsync(
            event({
              stream: "lifecycle",
              data: { phase: "end", startedAt: 0, endedAt: 31_000 },
            }),
          ),
          signal,
        );
        expect(backgroundRegistrations).toBeGreaterThan(0);
        await withinTest(backgroundFinished.promise, signal);
        await withinTest(Promise.all(backgroundSettlements), signal);

        expect(sourceChanges).toBe(1);
        expect(config.session?.store).toBe(replacementStore);
        expect(harness.broadcastToConnIds).not.toHaveBeenCalled();
        if (kind !== "synthesized terminal") {
          expect(harness.completeModel).toHaveBeenCalledOnce();
          expect(harness.persistDigest).not.toHaveBeenCalled();
        } else {
          expect(harness.completeModel).not.toHaveBeenCalled();
          expect(harness.persistDigest).toHaveBeenCalledOnce();
          expect(harness.persistDigest.mock.calls[0]?.[0].digest).toMatchObject({ health: "done" });
        }
      } finally {
        try {
          await harness?.observer.disposeAsync();
        } finally {
          factory.mockRestore();
          vi.restoreAllMocks();
          resetSessionObserverEventSequence();
        }
      }
    });
  },
);
