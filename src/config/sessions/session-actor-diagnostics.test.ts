import { channel } from "node:diagnostics_channel";
import { expect, it } from "vitest";
import { observeSessionActorCommand } from "./session-actor-diagnostics.js";

it("counts overlapping commands once and keeps unknown outcomes distinct from commits", () => {
  const commands = channel("openclaw.session.actor.command");
  const events: unknown[] = [];
  const collect = (event: unknown) => events.push(event);
  commands.subscribe(collect);
  try {
    const accepted = observeSessionActorCommand("acceptInput");
    const failed = observeSessionActorCommand("appendToolResult");
    const unknown = observeSessionActorCommand("completeTurn");
    const read = observeSessionActorCommand("read");
    const rejected = observeSessionActorCommand("patch");
    const event = (phase: string, outcome?: string) => ({
      event: outcome ? "settled" : "begin",
      sequence: expect.any(Number),
      phase,
      ...(outcome ? { outcome } : {}),
    });
    expect(events).toEqual(
      ["acceptInput", "appendToolResult", "completeTurn", "read", "patch"].map((phase) =>
        event(phase),
      ),
    );
    unknown.settled("unknown");
    read.settled("read");
    accepted.settled("committed");
    failed.settled("rolled-back");
    rejected.settled("rejected");
    unknown.settled("committed");
    accepted.settled("committed");

    expect(events.slice(5)).toEqual([
      event("completeTurn", "unknown"),
      event("read", "read"),
      event("acceptInput", "committed"),
      event("appendToolResult", "rolled-back"),
      event("patch", "rejected"),
    ]);
  } finally {
    commands.unsubscribe(collect);
  }
});

it("does not invent a command for a subscriber installed after its admission", () => {
  const unobserved = observeSessionActorCommand("completeTurn");
  const events: unknown[] = [];
  const commands = channel("openclaw.session.actor.command");
  const collect = (event: unknown) => events.push(event);
  commands.subscribe(collect);
  try {
    unobserved.settled("committed");
    expect(events).toEqual([]);
  } finally {
    commands.unsubscribe(collect);
  }
});
