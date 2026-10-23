import { beforeEach, expect, it, vi } from "vitest";
import { createSessionObserverModelSlots } from "./session-observer-model-slots.js";
import type { SessionObserverState } from "./session-observer-model.js";
import { observerState } from "./session-observer-state.test-support.js";

const modelState = (index: number, terminalHealth?: "done" | "failed") =>
  observerState({
    sessionKey: `agent:main:session-${index}`,
    lastActivityAt: index,
    ...(terminalHealth ? { terminalHealth, finalPending: true } : {}),
  });

let states: Map<string, SessionObserverState>;
let demote: ReturnType<typeof vi.fn<(state: SessionObserverState) => void>>;
let slots: ReturnType<typeof createSessionObserverModelSlots>;
beforeEach(() => {
  states = new Map();
  demote = vi.fn();
  slots = createSessionObserverModelSlots({ states, resolve: () => "openai/gpt-test", demote });
});

it("retains physical reservations after logical owners leave the state map", () => {
  demote.mockImplementation((state) => {
    state.utilityModelRef = undefined;
  });
  const running = Array.from({ length: 6 }, (_, index) => modelState(index));
  for (const state of running) {
    states.set(state.sessionKey, state);
    expect(slots.reserve(state)).toBe(true);
  }
  expect(slots.reserve(running[0]!)).toBe(false);

  const waiting = modelState(6);
  expect(slots.claim(waiting.agentId)).toBe(waiting.utilityModelRef);
  expect(running[0]?.utilityModelRef).toBeUndefined();
  states.clear();
  expect(slots.reserve(waiting)).toBe(false);

  slots.release(running[0]!);
  expect(slots.reserve(waiting)).toBe(true);
  expect(slots.reserve(modelState(7))).toBe(false);
});

it.each(["activity", "session-key"] as const)(
  "demotes the oldest nonterminal model state by %s",
  (order) => {
    const terminal = modelState(0, "done");
    states.set(terminal.sessionKey, terminal);
    for (const index of [5, 4, 3, 2, 1]) {
      const state = modelState(index);
      if (order === "session-key") {
        state.lastActivityAt = 1;
      }
      states.set(state.sessionKey, state);
    }

    expect(slots.claim("main")).toBe("openai/gpt-test");
    expect(demote).toHaveBeenCalledWith(states.get("agent:main:session-1"));
    expect(demote).not.toHaveBeenCalledWith(terminal);
  },
);

it.each(["terminal", "final-pending"] as const)(
  "does not evict %s states when every slot is protected",
  (kind) => {
    for (let index = 0; index < 6; index += 1) {
      const state = modelState(index, kind === "terminal" ? "done" : undefined);
      state.finalPending = kind === "final-pending";
      states.set(state.sessionKey, state);
    }

    expect(slots.claim("main")).toBeUndefined();
    expect(demote).not.toHaveBeenCalled();
  },
);
