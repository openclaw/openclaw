/**
 * Reference specification for the executable pilot, NOT a runtime controller.
 * It observes one retained ReplyOperation, V2 steering and its finishing writer.
 * Mailbox custody below is a target contract; the pilot does not migrate queues,
 * durable replay, command stop/children/hooks or lifecycle mutation scheduling.
 */
export type PilotInput = Readonly<{ id: string; authority: string }>;
export type PilotCustody = "offered" | "accepted" | "indeterminate" | "rejected" | "failed";
export type PilotEvent =
  | { type: "run" | "finish" | "stop" | "complete" | "delivery-settled" | "revoke" | "replace" }
  | { type: "compact"; active: boolean }
  | { type: "injection-available"; available: boolean }
  | { type: "offer"; input: PilotInput }
  | { type: "receipt"; id: string; outcome: "accepted" | "indeterminate" | "rejected" };
export type PilotEffect =
  | { type: "cancel" }
  | { type: "inject"; input: PilotInput; generation: number }
  | { type: "reject"; id: string };
export type PilotState = Readonly<{
  generation: number;
  phase: "preparing" | "running" | "finishing" | "terminal";
  slot: boolean;
  writer: boolean;
  cancelled: boolean;
  live: boolean;
  compacting: boolean;
  injectionAvailable: boolean;
  authority: string;
  inputs: Readonly<
    Record<string, { input: PilotInput; generation: number; custody: PilotCustody }>
  >;
}>;

export function initialPilotState(): PilotState {
  return {
    generation: 0,
    phase: "preparing",
    slot: true,
    writer: true,
    cancelled: false,
    live: true,
    compacting: false,
    injectionAvailable: true,
    authority: "alice-policy",
    inputs: {},
  };
}

export function stepPilot(
  state: PilotState,
  event: PilotEvent,
): { state: PilotState; effects: PilotEffect[] } {
  const unchanged = { state, effects: [] };
  switch (event.type) {
    case "run":
      return state.phase === "preparing"
        ? { state: { ...state, phase: "running" }, effects: [] }
        : unchanged;
    case "finish":
      return state.phase === "running"
        ? { state: { ...state, phase: "finishing" }, effects: [] }
        : unchanged;
    case "stop":
      // This is exact-parent cancellation only. A command stop is NOT modeled as
      // a no-op: queues, children and hooks retain their separate command owner.
      return state.phase === "preparing" || state.phase === "running"
        ? { state: { ...state, phase: "terminal", cancelled: true }, effects: [{ type: "cancel" }] }
        : unchanged;
    case "complete":
      return { state: { ...state, phase: "terminal", slot: false }, effects: [] };
    case "delivery-settled":
      return state.slot ? unchanged : { state: { ...state, writer: false }, effects: [] };
    case "revoke":
      return { state: { ...state, live: false }, effects: [] };
    case "injection-available":
      return { state: { ...state, injectionAvailable: event.available }, effects: [] };
    case "compact":
      return { state: { ...state, compacting: event.active }, effects: [] };
    case "replace":
      return state.slot
        ? unchanged
        : {
            state: {
              ...initialPilotState(),
              generation: state.generation + 1,
              inputs: state.inputs,
            },
            effects: [],
          };
    case "offer": {
      if (state.inputs[event.input.id]) {
        return unchanged;
      }
      // V2 admits during automatic compaction; no blanket compacting/busy gate.
      // freezeAbort commits cancellation policy, not a fabricated backend capability.
      // Real attempt settlement closes its sink separately; exercise both orders.
      const targetAvailable =
        state.slot &&
        (state.phase === "running" || state.phase === "finishing") &&
        state.injectionAvailable;
      const allowed = targetAvailable && state.live && event.input.authority === state.authority;
      const custody: PilotCustody =
        targetAvailable && !state.live ? "failed" : allowed ? "offered" : "rejected";
      return {
        state: {
          ...state,
          inputs: {
            ...state.inputs,
            [event.input.id]: {
              input: event.input,
              generation: state.generation,
              custody,
            },
          },
        },
        effects: allowed
          ? [{ type: "inject", input: event.input, generation: state.generation }]
          : [{ type: "reject", id: event.input.id }],
      };
    }
    case "receipt": {
      const entry = state.inputs[event.id];
      if (!entry || entry.custody !== "offered") {
        return unchanged;
      }
      const current =
        state.live &&
        state.slot &&
        (state.phase === "running" || state.phase === "finishing") &&
        entry.generation === state.generation;
      const custody = current ? event.outcome : "failed";
      return {
        state: { ...state, inputs: { ...state.inputs, [event.id]: { ...entry, custody } } },
        effects: [],
      };
    }
  }
  return event satisfies never;
}

export type PilotMailbox = Readonly<{
  capacity: number;
  waiting: readonly PilotInput[];
  retired: readonly string[];
}>;
export type PilotMailboxEvent = { type: "enqueue"; input: PilotInput; overflow: "old" | "new" };
export function stepPilotMailbox(
  state: PilotMailbox,
  event: PilotMailboxEvent,
): {
  state: PilotMailbox;
  effects: readonly { type: "retire"; id: string }[];
} {
  if (
    state.waiting.some((input) => input.id === event.input.id) ||
    state.retired.includes(event.input.id)
  ) {
    return { state, effects: [] };
  }
  if (state.capacity <= 0 || state.waiting.length < state.capacity) {
    return { state: { ...state, waiting: [...state.waiting, event.input] }, effects: [] };
  }
  const victim = event.overflow === "new" ? event.input : state.waiting[0];
  if (!victim) {
    throw new Error("A full mailbox must have an overflow victim");
  }
  return {
    state: {
      ...state,
      waiting: event.overflow === "new" ? state.waiting : [...state.waiting.slice(1), event.input],
      retired: [...state.retired, victim.id],
    },
    effects: [{ type: "retire", id: victim.id }],
  };
}

export type PilotParentInput = Readonly<{
  id: string;
  kind: "user" | "completion" | "settle";
  owedAt: number;
}>;

/** Durable completion identities rebuild once; user inputs remain process-local FIFO entries. */
export function modelParentMailbox(inputs: readonly PilotParentInput[]): PilotParentInput[] {
  const owed = new Set<string>();
  return inputs.filter((input) => {
    if (input.kind === "user") {
      return true;
    }
    if (owed.has(input.id)) {
      return false;
    }
    owed.add(input.id);
    return true;
  });
}

/** Seed is printed with the complete event prefix on failure; no external property-test dependency. */
export function pilotRandom(seed: number): (bound: number) => number {
  let value = (seed ^ 0x9e3779b9) >>> 0;
  return (bound) => {
    // Mix all bits; low-bit LCG sampling otherwise alternates binary choices.
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) % bound;
  };
}

/** State-aware bounded interleavings; output itself is a standalone replay corpus. */
export function generatePilotSequence(seed: number, length = 48): PilotEvent[] {
  const random = pilotRandom(seed);
  const events: PilotEvent[] = [];
  let state = initialPilotState();
  const add = (event: PilotEvent) => {
    events.push(event);
    state = stepPilot(state, event).state;
  };
  for (let index = 0; index < length; index++) {
    const choices: PilotEvent[] = [];
    const pending = Object.entries(state.inputs).filter(([, input]) => input.custody === "offered");
    for (const [id] of pending) {
      choices.push({
        type: "receipt",
        id,
        outcome: random(3) === 0 ? "rejected" : random(2) ? "accepted" : "indeterminate",
      });
    }
    if (!state.slot) {
      choices.push({ type: state.writer ? "delivery-settled" : "replace" });
    } else if (state.phase === "terminal") {
      // Retained cancelled owners await completion, not repeated no-op stops.
      choices.push({ type: "complete" });
    } else {
      if (state.phase === "preparing") {
        choices.push({ type: "run" }, { type: "run" });
      }
      if (state.phase === "running") {
        choices.push({ type: "finish" });
      }
      choices.push({ type: "stop" }, { type: "complete" });
      if (state.live) {
        choices.push({ type: "revoke" });
      }
      if (state.phase !== "preparing") {
        choices.push(
          { type: "compact", active: !state.compacting },
          { type: "injection-available", available: !state.injectionAvailable },
        );
      }
      const offer: PilotEvent = {
        type: "offer",
        input: {
          id: "seed-" + seed + "-" + index,
          authority: random(3) ? "alice-policy" : "bob-policy",
        },
      };
      // Exercise receipt races often enough instead of mostly terminal no-ops.
      choices.push(offer, offer, offer);
    }
    const event = choices[random(choices.length)];
    if (event) {
      add(event);
    }
  }
  for (const [id, input] of Object.entries(state.inputs)) {
    if (input.custody === "offered") {
      add({ type: "receipt", id, outcome: "accepted" });
    }
  }
  if (state.slot) {
    add({ type: "complete" });
  }
  if (state.writer) {
    add({ type: "delivery-settled" });
  }
  return events;
}
