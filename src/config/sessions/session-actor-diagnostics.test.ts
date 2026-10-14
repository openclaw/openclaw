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
    expect(events).toEqual([
      { event: "begin", sequence: expect.any(Number), phase: "acceptInput" },
      { event: "begin", sequence: expect.any(Number), phase: "appendToolResult" },
      { event: "begin", sequence: expect.any(Number), phase: "completeTurn" },
      { event: "begin", sequence: expect.any(Number), phase: "read" },
      { event: "begin", sequence: expect.any(Number), phase: "patch" },
    ]);
    unknown.settled("unknown");
    read.settled("read");
    accepted.settled("committed");
    failed.settled("rolled-back");
    rejected.settled("rejected");
    unknown.settled("committed");
    accepted.settled("committed");

    expect(events.slice(5)).toEqual([
      {
        event: "settled",
        sequence: expect.any(Number),
        phase: "completeTurn",
        outcome: "unknown",
      },
      { event: "settled", sequence: expect.any(Number), phase: "read", outcome: "read" },
      {
        event: "settled",
        sequence: expect.any(Number),
        phase: "acceptInput",
        outcome: "committed",
      },
      {
        event: "settled",
        sequence: expect.any(Number),
        phase: "appendToolResult",
        outcome: "rolled-back",
      },
      { event: "settled", sequence: expect.any(Number), phase: "patch", outcome: "rejected" },
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
