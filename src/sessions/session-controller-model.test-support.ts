// Independent reference models for controller scheduling, steering, and durable
// input custody. Runtime behavior is exercised by adapters in the test file.
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
  | { type: "inject"; input: PilotInput }
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
  inputs: Readonly<Record<string, { generation: number; custody: PilotCustody }>>;
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
  const update = (patch: Partial<PilotState>, effects: PilotEffect[] = []) => ({
    state: { ...state, ...patch },
    effects,
  });
  switch (event.type) {
    case "run":
      return state.phase === "preparing" ? update({ phase: "running" }) : unchanged;
    case "finish":
      return state.phase === "running" ? update({ phase: "finishing" }) : unchanged;
    case "stop":
      // Command-level queues, children and hooks have a separate cancellation owner.
      return state.phase === "preparing" || state.phase === "running"
        ? update({ phase: "terminal", cancelled: true }, [{ type: "cancel" }])
        : unchanged;
    case "complete":
      return update({ phase: "terminal", slot: false });
    case "delivery-settled":
      return state.slot ? unchanged : update({ writer: false });
    case "revoke":
      return update({ live: false });
    case "injection-available":
      return update({ injectionAvailable: event.available });
    case "compact":
      return update({ compacting: event.active });
    case "replace":
      return state.slot
        ? unchanged
        : update({
            ...initialPilotState(),
            generation: state.generation + 1,
            inputs: state.inputs,
          });
    case "offer": {
      if (state.inputs[event.input.id]) {
        return unchanged;
      }
      // Compaction does not close V2 injection; actual attempt settlement does.
      const targetAvailable =
        state.slot &&
        (state.phase === "running" || state.phase === "finishing") &&
        state.injectionAvailable;
      const allowed = targetAvailable && state.live && event.input.authority === state.authority;
      const custody: PilotCustody =
        targetAvailable && !state.live ? "failed" : allowed ? "offered" : "rejected";
      return update(
        {
          inputs: { ...state.inputs, [event.input.id]: { generation: state.generation, custody } },
        },
        allowed
          ? [{ type: "inject", input: event.input }]
          : [{ type: "reject", id: event.input.id }],
      );
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
      return update({ inputs: { ...state.inputs, [event.id]: { ...entry, custody } } });
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
): { state: PilotMailbox } {
  if (
    state.waiting.some((input) => input.id === event.input.id) ||
    state.retired.includes(event.input.id)
  ) {
    return { state };
  }
  if (state.capacity <= 0 || state.waiting.length < state.capacity) {
    return { state: { ...state, waiting: [...state.waiting, event.input] } };
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

function pilotRandom(seed: number): (bound: number) => number {
  let value = (seed ^ 0x9e3779b9) >>> 0;
  return (bound) => {
    // Mix all bits; low-bit LCG sampling otherwise alternates binary choices.
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) % bound;
  };
}

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

type DurablePilotInput = Readonly<{ id: string; recoverable: boolean }>;
export type DurablePilotEvent =
  | { type: "append"; input: DurablePilotInput }
  | { type: "claim" | "adopt" | "resend"; id: string }
  | { type: "crash" }
  | { type: "replay"; dispatchAvailable: boolean };
type DurablePilotCustody = "queued" | "consumed" | "restart-unrecoverable";
export type DurablePilotState = Readonly<
  Record<string, { recoverable: boolean; custody: DurablePilotCustody }>
>;

export function stepDurablePilot(
  state: DurablePilotState,
  event: DurablePilotEvent,
): DurablePilotState {
  switch (event.type) {
    case "append":
      return {
        ...state,
        [event.input.id]: { recoverable: event.input.recoverable, custody: "queued" },
      };
    case "adopt":
      return { ...state, [event.id]: { ...state[event.id]!, custody: "consumed" } };
    case "replay": {
      let blocked = false;
      return Object.fromEntries(
        Object.entries(state).map(([id, input]) => {
          if (input.custody !== "queued" || blocked) {
            return [id, input];
          }
          if (input.recoverable && !event.dispatchAvailable) {
            // FIFO custody remains with this row and every later waiting input.
            blocked = true;
            return [id, input];
          }
          return [
            id,
            {
              ...input,
              custody: input.recoverable ? "consumed" : "restart-unrecoverable",
            },
          ];
        }),
      );
    }
    default:
      return state;
  }
}

/** Every seed includes a lost commit confirmation and a claimed-but-unadopted input. */
export function generateDurablePilotSequence(seed: number): DurablePilotEvent[] {
  const random = pilotRandom(seed);
  const inputs = Array.from({ length: 4 }, (_, index) => ({
    id: `durable-${seed}-${index}`,
    recoverable: index !== 3,
  }));
  for (let index = inputs.length - 1; index > 0; index--) {
    const other = random(index + 1);
    [inputs[index], inputs[other]] = [inputs[other]!, inputs[index]!];
  }
  const committed = inputs.find((input) => input.recoverable)!;
  const claimed = inputs.find((input) => input.recoverable && input !== committed)!;
  const resends: DurablePilotEvent[] = inputs
    .filter((input) => input.recoverable)
    .map(({ id }) => ({ type: "resend", id }));
  return [
    ...inputs.map((input): DurablePilotEvent => ({ type: "append", input })),
    { type: "claim", id: committed.id },
    { type: "adopt", id: committed.id },
    { type: "claim", id: claimed.id },
    { type: "crash" },
    { type: "replay", dispatchAvailable: false },
    { type: "replay", dispatchAvailable: true },
    ...resends,
    { type: "crash" },
    { type: "replay", dispatchAvailable: true },
    ...resends,
  ];
}
