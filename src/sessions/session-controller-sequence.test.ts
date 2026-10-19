import { describe, expect, it, vi } from "vitest";
import {
  getActiveNativeAttempt,
  type EmbeddedAgentQueueHandle,
} from "../agents/embedded-agent-runner/run-state.js";
import {
  detachActiveEmbeddedRun,
  attachActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { pilotRandom } from "./session-controller-model.test-support.js";
import { withSessionTurn } from "./session-controller.admission.js";
import type { ReplyBackendHandle, ReplyOperation } from "./session-controller.contracts.js";
import {
  captureSessionTarget,
  getCurrentSessionControllerClaim,
  runSessionMutation,
} from "./session-controller.lifecycle.js";
import {
  abortSessionControllerInput,
  captureSessionControllerSourceSettlement,
  getExistingSessionControllerMailbox,
  holdSessionControllerSourceWithdrawal,
  reserveSessionControllerSource,
  releaseSessionControllerClaim,
  type SessionControllerMailboxClaim,
  type SessionControllerInput,
} from "./session-controller.mailbox.js";
import { getSessionControllerOperation } from "./session-controller.state.js";

type Event =
  | { type: "reserve"; id: number; interrupt?: boolean }
  | { type: "native"; id: number }
  | {
      type:
        | "ready"
        | "hold"
        | "withdraw"
        | "release-hold"
        | "cancel"
        | "finish"
        | "owner-settled"
        | "source-settled"
        | "retry"
        | "late-detach"
        | "stop";
      id: number;
    }
  | { type: "mutation" }
  | { type: "mutation-settled" }
  | { type: "tick" };

type Mail = {
  id: number;
  native: boolean;
  ready: boolean;
  held: boolean;
  selected: boolean;
  retiring: boolean;
  done: boolean;
  finished: boolean;
  ownerSettled: boolean;
  sourceSettled: boolean;
  stopped: boolean;
  attempt: number;
};
type Model = {
  mail: Mail[];
  priority?: number;
  active?: number;
  mutation?: { waitingFor?: number; running: boolean };
  starts: number[];
  cancelled: number[];
  backendStops: string[];
  mutationsStarted: number;
};
function initialModel(): Model {
  return { mail: [], starts: [], cancelled: [], backendStops: [], mutationsStarted: 0 };
}
function mail(model: Model, id: number): Mail {
  const found = model.mail.find((entry) => entry.id === id);
  if (!found) {
    throw new Error("Unknown model input " + id);
  }
  return found;
}

// Contract model: arrival order, a single newest interrupt, and two independent
// completion receipts. No production reducer, registry, claim, or phase is read.
function advance(model: Model, event: Event): boolean | undefined {
  let accepted: boolean | undefined;
  if (event.type === "reserve" || event.type === "native") {
    const native = event.type === "native";
    model.mail.push({
      id: event.id,
      native,
      ready: native,
      held: false,
      selected: false,
      retiring: false,
      done: false,
      finished: false,
      ownerSettled: false,
      sourceSettled: native,
      stopped: false,
      attempt: 0,
    });
    if (event.type === "reserve" && event.interrupt) {
      model.priority = event.id;
    }
  } else if (event.type === "mutation") {
    model.mutation = { waitingFor: model.active, running: false };
  } else if (event.type === "mutation-settled") {
    model.mutation = undefined;
  } else if (event.type !== "tick") {
    const entry = mail(model, event.id);
    switch (event.type) {
      case "ready":
        entry.ready = true;
        break;
      case "hold":
        entry.held = true;
        break;
      case "release-hold":
        entry.held = false;
        break;
      case "withdraw":
      case "cancel": {
        accepted =
          !entry.selected &&
          !entry.retiring &&
          !entry.done &&
          (event.type === "withdraw" ? entry.held : !entry.held);
        if (accepted) {
          entry.held = false;
          entry.retiring = true;
          model.cancelled.push(entry.id);
          if (model.priority === entry.id) {
            model.priority = undefined;
          }
        }
        break;
      }
      case "finish":
        entry.finished = true;
        break;
      case "owner-settled":
        entry.ownerSettled = true;
        break;
      case "source-settled":
        entry.sourceSettled = true;
        break;
      case "retry":
        entry.attempt++;
        break;
      case "late-detach":
        break;
      case "stop":
        accepted = !entry.finished && !entry.stopped;
        if (accepted) {
          entry.stopped = true;
          model.backendStops.push(entry.id + ":" + entry.attempt);
        }
        break;
    }
  }
  for (const entry of model.mail) {
    if (entry.selected && entry.finished && entry.ownerSettled) {
      entry.retiring = true;
    }
    if (entry.retiring && entry.sourceSettled) {
      entry.done = true;
      if (model.active === entry.id) {
        model.active = undefined;
      }
    }
  }
  const mutation = model.mutation;
  if (
    mutation &&
    !mutation.running &&
    (mutation.waitingFor === undefined || mail(model, mutation.waitingFor).done) &&
    // Withdrawal can start raw cleanup without ever selecting a turn.
    !model.mail.some((entry) => entry.retiring && !entry.done)
  ) {
    mutation.running = true;
    model.mutationsStarted++;
  }
  if (
    model.active !== undefined ||
    mutation ||
    model.mail.some((entry) => entry.retiring && !entry.done)
  ) {
    return accepted;
  }
  const next =
    model.priority === undefined
      ? model.mail.find((entry) => !entry.done)
      : mail(model, model.priority);
  if (next?.ready && !next.held) {
    next.selected = true;
    model.active = next.id;
    model.starts.push(next.id);
    if (model.priority === next.id) {
      model.priority = undefined;
    }
  }
  return accepted;
}

// The fixed prefix forces cross-owner races; generated suffixes vary readiness,
// withdrawal and the relative arrival of raw-owner and source-cleanup receipts.
const prefix: readonly Event[] = [
  { type: "reserve", id: -1 },
  { type: "native", id: 0 },
  { type: "ready", id: -1 },
  { type: "finish", id: -1 },
  { type: "owner-settled", id: -1 },
  { type: "tick" },
  // A wait-policy mutation must also join a selected source whose native owner
  // has finished but whose onSettled callback still owns cleanup/persistence.
  { type: "mutation" },
  { type: "source-settled", id: -1 },
  { type: "mutation-settled" },
  { type: "reserve", id: 1 },
  { type: "native", id: 2 },
  { type: "reserve", id: 3 },
  { type: "ready", id: 3 },
  { type: "reserve", id: 4, interrupt: true },
  { type: "ready", id: 4 },
  { type: "reserve", id: 5, interrupt: true },
  { type: "hold", id: 1 },
  { type: "reserve", id: 6 },
  { type: "ready", id: 6 },
  { type: "cancel", id: 1 },
  { type: "withdraw", id: 1 },
  { type: "stop", id: 0 },
  { type: "finish", id: 0 },
  { type: "tick" },
  { type: "owner-settled", id: 0 },
  { type: "source-settled", id: 1 },
  { type: "ready", id: 5 },
  { type: "retry", id: 5 },
  { type: "late-detach", id: 5 },
  { type: "withdraw", id: 1 },
  { type: "cancel", id: 1 },
  { type: "mutation" },
  { type: "finish", id: 5 },
  { type: "tick" },
  { type: "owner-settled", id: 5 },
  { type: "tick" },
  { type: "source-settled", id: 5 },
  { type: "mutation-settled" },
  { type: "late-detach", id: 5 },
  { type: "finish", id: 2 },
  { type: "owner-settled", id: 2 },
  { type: "finish", id: 3 },
  { type: "source-settled", id: 3 },
  { type: "owner-settled", id: 3 },
];
function sequence(seed: number): Event[] {
  const model = initialModel();
  const events: Event[] = [];
  const add = (event: Event) => {
    events.push(event);
    advance(model, event);
  };
  for (const event of prefix) {
    add(event);
  }
  const random = pilotRandom(seed);
  for (let step = 0; step < 24; step++) {
    const choices: Event[] = [];
    if (model.mail.length < 10) {
      choices.push({ type: "reserve", id: model.mail.length, interrupt: random(2) === 0 });
      choices.push({ type: "native", id: model.mail.length });
    }
    for (const entry of model.mail.filter((candidate) => !candidate.done)) {
      const id = entry.id;
      if (!entry.native && !entry.sourceSettled) {
        choices.push({ type: "source-settled", id });
      }
      if (!entry.ownerSettled) {
        choices.push({ type: "owner-settled", id });
      }
      if (entry.selected) {
        if (!entry.finished) {
          choices.push({ type: "finish", id }, { type: "stop", id });
        }
        if (!entry.finished && !entry.stopped) {
          choices.push({ type: "retry", id });
        }
        if (entry.attempt) {
          choices.push({ type: "late-detach", id });
        }
      } else if (!entry.retiring && !entry.native) {
        if (!entry.ready) {
          choices.push({ type: "ready", id });
        }
        if (entry.held) {
          choices.push({ type: "withdraw", id }, { type: "release-hold", id });
        } else {
          choices.push({ type: "hold", id }, { type: "cancel", id });
        }
      }
    }
    if (model.mutation?.running) {
      choices.push({ type: "mutation-settled" });
    } else if (!model.mutation) {
      choices.push({ type: "mutation" });
    }
    if (choices.length) {
      add(required(choices[random(choices.length)]));
    }
  }
  // Drain by model progress, not by consulting implementation state. A selector
  // deadlock fails at its first mismatching prefix instead of hanging the suite.
  for (let remaining = 0; remaining < 100 && model.mail.some((entry) => !entry.done); remaining++) {
    const retiring = model.mail.find((entry) => entry.retiring && !entry.done);
    if (retiring) {
      add({ type: "source-settled", id: retiring.id });
    } else if (model.active !== undefined) {
      const entry = mail(model, model.active);
      add({
        type: !entry.finished ? "finish" : !entry.ownerSettled ? "owner-settled" : "source-settled",
        id: entry.id,
      });
    } else if (model.mutation) {
      add({ type: "mutation-settled" });
    } else {
      const entry =
        model.priority === undefined
          ? model.mail.find((item) => !item.done)!
          : mail(model, model.priority);
      add({ type: entry.held ? "release-hold" : "ready", id: entry.id });
    }
  }
  if (model.mutation) {
    add({ type: "mutation-settled" });
  }
  return events;
}

type Native = EmbeddedAgentQueueHandle & ReplyBackendHandle;
function nativeHandle(cancel: () => void): Native {
  return {
    kind: "embedded",
    runId: "same-native-id",
    queueMessage: async () => {},
    isStreaming: () => true,
    isCompacting: () => false,
    abort: cancel,
    cancel,
  };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Missing sequence fixture");
  }
  return value;
}
type Fixture = {
  input?: SessionControllerInput;
  hold?: ReturnType<typeof holdSessionControllerSourceWithdrawal>;
  operation?: ReplyOperation;
  handles: Native[];
  cancel: AbortController;
  finish: Deferred;
  owner: Deferred;
  source: Deferred;
};

async function replay(seed: number, events = sequence(seed)) {
  const key = "agent:main:controller-sequence-" + seed;
  const sessionId = "sequence-incarnation-" + seed;
  const target = captureSessionTarget({
    storeScope: "sequence.sqlite",
    sessionKey: key,
    incarnation: sessionId,
  });
  const model = initialModel();
  const fixtures = new Map<number, Fixture>();
  const starts: number[] = [];
  const cancelled: number[] = [];
  const backendStops: string[] = [];
  const ownersSettled: number[] = [];
  const cleanupStarted: number[] = [];
  const settled: number[] = [];
  const rejected: number[] = [];
  const errors: unknown[] = [];
  const jobs: Promise<unknown>[] = [];
  const mutationGates: Deferred[] = [];
  let mutationStarted = 0;
  const observedPrefix: Event[] = [];
  const attach = (id: number) => {
    const fixture = required(fixtures.get(id));
    const attempt = fixture.handles.length;
    const handle = nativeHandle(() => backendStops.push(id + ":" + attempt));
    fixture.handles.push(handle);
    attachActiveEmbeddedRun(sessionId, handle, key, undefined, "main", required(fixture.operation));
  };
  const launch = (id: number) => {
    const fixture = required(fixtures.get(id));
    const job = withSessionTurn(
      {
        sessionKey: key,
        sessionId,
        target,
        controllerInput: fixture.input,
        abortSignal: fixture.cancel.signal,
      },
      async (operation) => {
        fixture.operation = required(operation);
        jobs.push(
          required(operation?.ownerSettlement).then(() => {
            ownersSettled.push(id);
          }),
        );
        starts.push(id);
        attach(id);
        await fixture.finish.promise;
        detachActiveEmbeddedRun(sessionId, required(fixture.handles.at(-1)));
        // This receipt models raw execution cleanup, not after-clear delivery.
        const releaseExecution = fixture.operation.retainExecution();
        void fixture.owner.promise.then(releaseExecution);
        fixture.operation.complete();
      },
    );
    jobs.push(
      job.catch((error: unknown) => {
        rejected.push(id);
        errors.push(error);
      }),
    );
  };
  try {
    for (const event of events) {
      observedPrefix.push(event);
      const expected = advance(model, event);
      let actual: boolean | undefined;
      if (event.type === "reserve" || event.type === "native") {
        const fixture: Fixture = {
          handles: [],
          cancel: new AbortController(),
          finish: createDeferredCore(),
          owner: createDeferredCore(),
          source: createDeferredCore(),
        };
        fixtures.set(event.id, fixture);
        if (event.type === "reserve") {
          fixture.input = reserveSessionControllerSource(key, {
            target,
            protocolRunId: " same-source-id ",
            sourceTurnId: "same-source-turn",
            policy: { mode: event.interrupt ? "interrupt" : "followup" },
            adapter: {
              signal: fixture.cancel.signal,
              cancel: () => {
                cancelled.push(event.id);
              },
              onSettled: () => {
                cleanupStarted.push(event.id);
                return fixture.source.promise;
              },
            },
          });
          jobs.push(
            captureSessionControllerSourceSettlement(fixture.input).then(() => {
              settled.push(event.id);
            }),
          );
        } else {
          launch(event.id);
        }
      } else if (event.type === "mutation") {
        const gate = createDeferredCore();
        mutationGates.push(gate);
        jobs.push(
          runSessionMutation({
            target,
            policy: "wait",
            run: async () => {
              mutationStarted++;
              await gate.promise;
            },
          }),
        );
      } else if (event.type === "mutation-settled") {
        required(mutationGates.at(-1)).resolve();
      } else if (event.type !== "tick") {
        const fixture = required(fixtures.get(event.id));
        switch (event.type) {
          case "ready":
            launch(event.id);
            break;
          case "hold":
            fixture.hold = holdSessionControllerSourceWithdrawal(required(fixture.input));
            break;
          case "release-hold":
            required(fixture.hold).release();
            break;
          case "withdraw":
            actual = required(fixture.hold).commit();
            break;
          case "cancel":
            actual = abortSessionControllerInput(required(fixture.input));
            break;
          case "finish":
            fixture.finish.resolve();
            break;
          case "owner-settled":
            fixture.owner.resolve();
            break;
          case "source-settled":
            fixture.source.resolve();
            break;
          case "retry":
            attach(event.id);
            break;
          case "late-detach":
            detachActiveEmbeddedRun(sessionId, required(fixture.handles[0]));
            break;
          case "stop":
            actual = required(fixture.operation).abortByUser();
            break;
        }
      }
      // Flush actual async continuations with a fake clock, never sleeps/polling.
      // Advancing the clock cannot resolve either raw cleanup receipt.
      await vi.advanceTimersByTimeAsync(event.type === "tick" ? 6 : 0);
      const context =
        "seed=" +
        seed +
        " prefix=" +
        JSON.stringify(observedPrefix) +
        " errors=" +
        errors.map(String).join(";");
      expect(actual, context).toBe(expected);
      expect(starts, context).toEqual(model.starts);
      expect(cancelled, context).toEqual(model.cancelled);
      expect(backendStops, context).toEqual(model.backendStops);
      expect(mutationStarted, context).toBe(model.mutationsStarted);
      expect(
        [...ownersSettled].toSorted((a, b) => a - b),
        context,
      ).toEqual(
        model.mail
          .filter((entry) => entry.selected && entry.finished && entry.ownerSettled)
          .map((entry) => entry.id),
      );
      expect(
        [...cleanupStarted].toSorted((a, b) => a - b),
        context,
      ).toEqual(
        model.mail.filter((entry) => !entry.native && entry.retiring).map((entry) => entry.id),
      );
      expect(
        [...settled].toSorted((a, b) => a - b),
        context,
      ).toEqual(model.mail.filter((entry) => !entry.native && entry.done).map((entry) => entry.id));
      expect(
        [...rejected].toSorted((a, b) => a - b),
        context,
      ).toEqual(
        model.mail
          .filter((entry) => !entry.selected && entry.ready && entry.retiring)
          .map((entry) => entry.id),
      );
      const active = model.active === undefined ? undefined : mail(model, model.active);
      const owner =
        active && !(active.finished && active.ownerSettled)
          ? required(fixtures.get(active.id))
          : undefined;
      const native = active && !active.finished ? required(fixtures.get(active.id)) : undefined;
      expect(getSessionControllerOperation(key, target), context).toBe(owner?.operation);
      expect(getActiveNativeAttempt(sessionId), context).toBe(native?.handles.at(-1));
      for (const entry of model.mail.filter((candidate) => candidate.selected)) {
        expect(required(fixtures.get(entry.id)?.operation).abortSignal.aborted, context).toBe(
          entry.stopped,
        );
      }
    }
    expect(model.mail.every((entry) => entry.done)).toBe(true);
    expect(getExistingSessionControllerMailbox(key, target)?.entries ?? []).toEqual([]);
  } catch (error) {
    throw new Error("seed=" + seed + " prefix=" + JSON.stringify(observedPrefix), { cause: error });
  } finally {
    for (const gate of mutationGates) {
      gate.resolve();
    }
    for (const fixture of fixtures.values()) {
      fixture.hold?.release();
      fixture.cancel.abort();
      fixture.finish.resolve();
      fixture.owner.resolve();
      fixture.source.resolve();
    }
    await vi.advanceTimersByTimeAsync(0);
    await Promise.allSettled(jobs);
    for (const fixture of fixtures.values()) {
      for (const handle of fixture.handles) {
        detachActiveEmbeddedRun(sessionId, handle);
      }
    }
  }
}

describe("real controller selector sequences", () => {
  it("waits for sources withdrawn after a mutation captured its cleanup receipts", async () => {
    vi.useFakeTimers();
    try {
      await replay(3, [
        ...prefix,
        { type: "hold", id: 6 },
        { type: "owner-settled", id: 6 },
        { type: "owner-settled", id: 4 },
        { type: "mutation" },
        { type: "finish", id: 4 },
        { type: "withdraw", id: 6 },
        { type: "source-settled", id: 4 },
        { type: "reserve", id: 8, interrupt: false },
        { type: "native", id: 9 },
        { type: "hold", id: 8 },
        { type: "withdraw", id: 8 },
        { type: "source-settled", id: 6 },
        { type: "source-settled", id: 8 },
        { type: "mutation-settled" },
        { type: "finish", id: 9 },
        { type: "owner-settled", id: 9 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches bounded mixed-producer sequences through raw owner, source and mutation fences", async () => {
    vi.useFakeTimers();
    try {
      for (let seed = 1; seed <= 16; seed++) {
        await replay(seed);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("borrows the admitted native turn inside a mutation without admitting its queued competitor", async () => {
    vi.useFakeTimers();
    const key = "agent:main:sequence-borrow";
    const sessionId = "sequence-borrow";
    const target = captureSessionTarget({
      storeScope: "sequence.sqlite",
      sessionKey: key,
      incarnation: sessionId,
    });
    const entered = createDeferredCore();
    const mutate = createDeferredCore();
    const borrowed = createDeferredCore();
    const leaveMutation = createDeferredCore();
    const finish = createDeferredCore();
    const abort = new AbortController();
    const order: string[] = [];
    let competitor: Promise<void> | undefined;
    let owner: ReplyOperation | undefined;
    let claim: SessionControllerMailboxClaim | undefined;
    const handles: Native[] = [];
    const first = withSessionTurn({ sessionKey: key, sessionId, target }, async (operation) => {
      owner = required(operation);
      claim = getCurrentSessionControllerClaim();
      entered.resolve();
      await mutate.promise;
      await runSessionMutation({
        target,
        policy: "wait",
        run: async () => {
          order.push("mutation");
          await withSessionTurn({ sessionKey: key, sessionId, target }, async (nested) => {
            expect(nested).toBe(operation);
            const old = nativeHandle(() => {
              order.push("old-cancel");
            });
            const replacement = nativeHandle(() => {
              order.push("replacement-cancel");
            });
            handles.push(old, replacement);
            attachActiveEmbeddedRun(sessionId, old, key, undefined, "main", nested);
            attachActiveEmbeddedRun(sessionId, replacement, key, undefined, "main", nested);
            detachActiveEmbeddedRun(sessionId, old);
            expect(getActiveNativeAttempt(sessionId)).toBe(replacement);
            detachActiveEmbeddedRun(sessionId, replacement);
            order.push("borrowed");
          });
          borrowed.resolve();
          await leaveMutation.promise;
        },
      });
      order.push("mutation-released");
      await finish.promise;
    });
    void first.catch(() => {});
    try {
      await entered.promise;
      // Request outside the owner's async context: matching IDs cannot borrow it.
      competitor = withSessionTurn(
        { sessionKey: key, sessionId, target, abortSignal: abort.signal },
        async () => {
          order.push("competitor");
        },
      );
      void competitor.catch(() => {});
      mutate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["mutation", "borrowed"]);
      await borrowed.promise;
      leaveMutation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(["mutation", "borrowed", "mutation-released"]);
      finish.resolve();
      await Promise.all([first, competitor]);
      expect(order).toEqual(["mutation", "borrowed", "mutation-released", "competitor"]);
    } finally {
      abort.abort();
      mutate.resolve();
      leaveMutation.resolve();
      finish.resolve();
      // Unwind a self-wait regression too, preserving the assertion failure.
      owner?.complete();
      if (claim) {
        releaseSessionControllerClaim(claim);
      }
      for (const handle of handles) {
        detachActiveEmbeddedRun(sessionId, handle);
      }
      await vi.advanceTimersByTimeAsync(0);
      await Promise.allSettled([first, ...(competitor ? [competitor] : [])]);
      vi.useRealTimers();
    }
  });
});
