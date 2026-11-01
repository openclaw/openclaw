import { describe, expect, it, vi } from "vitest";
import { runLinkSteps, type LinkStep, type LinkStepState } from "./link-steps.ts";

const messages = {
  notPublished: (publication: Parameters<Parameters<typeof runLinkSteps>[1]["notPublished"]>[0]) =>
    `not listed (${publication?.state === "failed" ? publication.code : "pending"})`,
  relayOffline: "relay offline",
};

// Runs the steps and returns the last state each step reported.
async function run(actions: Parameters<typeof runLinkSteps>[0]) {
  const states = new Map<LinkStep, LinkStepState>();
  const outcome = await runLinkSteps(actions, messages, (step, state) =>
    states.set(step, state),
  ).then(
    (publication) => ({ publication }),
    (error: unknown) => ({ error }),
  );
  return { states: Object.fromEntries(states), outcome };
}

describe("Make reachable linking steps", () => {
  it("runs the four steps in order and finishes when published and online", async () => {
    const order: string[] = [];
    const { states, outcome } = await run({
      sign: async () => void order.push("sign"),
      commit: async () => {
        order.push("commit");
        return { state: "published", ownerAccountId: "acct", snapshotSeq: 1 };
      },
      relayOnline: async () => {
        order.push("relay");
        return true;
      },
    });
    expect(order).toEqual(["sign", "commit", "relay"]);
    expect(states).toEqual({
      sign: { state: "done" },
      pin: { state: "done" },
      reserve: { state: "done" },
      relay: { state: "done" },
    });
    expect(outcome).toEqual({ publication: expect.objectContaining({ state: "published" }) });
  });

  it("stops at a refused commit and never claims the later steps", async () => {
    const relayOnline = vi.fn(async () => true);
    const { states, outcome } = await run({
      sign: async () => {},
      commit: async () => {
        throw new Error("root already pinned");
      },
      relayOnline,
    });
    expect(states.pin).toEqual({ state: "failed", message: "root already pinned" });
    expect(states.reserve).toBeUndefined();
    expect(relayOnline).not.toHaveBeenCalled();
    expect(outcome).toHaveProperty("error");
  });

  it("warns, without failing, when the claw isn't listed or the relay isn't up yet", async () => {
    const { states } = await run({
      sign: async () => {},
      commit: async () => ({ state: "failed", code: "discovery", message: "HTTP 503" }),
      relayOnline: async () => false,
    });
    expect(states.reserve).toEqual({ state: "warning", message: "not listed (discovery)" });
    expect(states.relay).toEqual({ state: "warning", message: "relay offline" });
  });
});
