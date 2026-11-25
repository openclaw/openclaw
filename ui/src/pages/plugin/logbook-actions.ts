import { action, affects, createMemo, createOptimistic, refresh } from "solid-js";
import type { LogbookModel } from "./logbook-state.ts";

type Kind = "capture" | "analyze" | "standup" | "ask";

export function createLogbookActions(model: LogbookModel, getRetired: () => Promise<void>) {
  const statusRead = createMemo(() => model.state.status);
  const standup = createMemo(() => model.state.standup);
  const answer = createMemo(() => model.state.askAnswer);
  const [paused, setPaused] = createOptimistic(() => statusRead()?.capturePaused ?? false);
  const [actionPending, setActionPending] = createOptimistic(false);
  const [standupPending, setStandupPending] = createOptimistic(false);
  const [askPending, setAskPending] = createOptimistic(false);
  const status = createMemo(() => {
    const current = statusRead();
    return current && { ...current, capturePaused: paused() };
  });

  const present = action(function* (
    kind: Kind,
    pending: Promise<unknown>,
    retirement: Promise<void>,
    isCurrent: () => boolean,
    expectedPaused?: boolean,
  ) {
    const read = kind === "standup" ? standup : kind === "ask" ? answer : statusRead;
    const saving =
      kind === "standup" ? setStandupPending : kind === "ask" ? setAskPending : setActionPending;
    try {
      if (isCurrent()) {
        saving(true);
        if (expectedPaused !== undefined) {
          setPaused(expectedPaused);
        }
        affects(read);
      }
      // Retire presentation without cancelling the owner's admitted write.
      yield Promise.race([pending, retirement]);
      if (isCurrent()) {
        yield refresh(read);
      }
    } catch (error) {
      if (isCurrent()) {
        model.reportError(error);
      }
    }
  });

  async function perform(
    kind: Kind,
    run: () => Promise<unknown> | undefined,
    expectedPaused?: boolean,
  ) {
    const routeLifetime = getRetired();
    const dayLifetime = model.dayRetired;
    const isCurrent = () => getRetired() === routeLifetime && model.dayRetired === dayLifetime;
    const pending = run();
    if (!pending) {
      return;
    }
    const retirement = Promise.race([routeLifetime, dayLifetime]);
    await Promise.resolve();
    return present(kind, pending, retirement, isCurrent, expectedPaused);
  }

  return {
    status,
    standup,
    answer,
    actionPending,
    standupPending,
    askPending,
    setCapturePaused: (value: boolean) =>
      perform("capture", () => model.setCapturePaused(value), value),
    analyze: () => perform("analyze", () => model.analyze()),
    createStandup: (update: boolean) => perform("standup", () => model.standup(update)),
    ask: (question: string) =>
      question.trim() ? perform("ask", () => model.ask(question)) : Promise.resolve(),
  };
}

export type LogbookActions = ReturnType<typeof createLogbookActions>;
