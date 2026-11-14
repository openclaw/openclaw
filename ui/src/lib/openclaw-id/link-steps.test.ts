import { describe, expect, it } from "vitest";
import {
  RELAY_CHECK_INTERVAL_MS,
  RELAY_GRACE_MS,
  runLinkSteps,
  watchRelay,
  type LinkStep,
  type LinkStepState,
} from "./link-steps.ts";

const messages = {
  notPublished: (publication: Parameters<Parameters<typeof runLinkSteps>[1]["notPublished"]>[0]) =>
    `not listed (${publication?.state === "failed" ? publication.code : "pending"})`,
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
  it("signs, commits and registers in order and finishes when published", async () => {
    const order: string[] = [];
    const { states, outcome } = await run({
      sign: async () => void order.push("sign"),
      commit: async () => {
        order.push("commit");
        return { state: "published", ownerAccountId: "acct", snapshotSeq: 1 };
      },
    });
    expect(order).toEqual(["sign", "commit"]);
    expect(states).toEqual({
      sign: { state: "done" },
      pin: { state: "done" },
      reserve: { state: "done" },
    });
    expect(outcome).toEqual({ publication: expect.objectContaining({ state: "published" }) });
  });

  it("stops at a refused commit and never claims the later steps", async () => {
    const { states, outcome } = await run({
      sign: async () => {},
      commit: async () => {
        throw new Error("root already pinned");
      },
    });
    expect(states.pin).toEqual({ state: "failed", message: "root already pinned" });
    expect(states.reserve).toBeUndefined();
    expect(outcome).toHaveProperty("error");
  });

  it("warns, without failing, when the claw isn't listed", async () => {
    const { states } = await run({
      sign: async () => {},
      commit: async () => ({ state: "failed", code: "discovery", message: "HTTP 503" }),
    });
    expect(states.reserve).toEqual({ state: "warning", message: "not listed (discovery)" });
  });
});

describe("Make reachable relay step", () => {
  // Watches a relay whose reads answer from `online` in turn (the last answer repeats), on a
  // clock that each sleep advances; returns every relay state reported and the sleeps taken.
  async function watch(online: boolean[], active = () => true) {
    let clock = 0;
    let reads = 0;
    const sleeps: number[] = [];
    const states: LinkStepState[] = [];
    await watchRelay(
      {
        relayOnline: async () => online[Math.min(reads++, online.length - 1)]!,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        active,
        now: () => clock,
      },
      "relay offline",
      (step, state) => {
        expect(step).toBe("relay");
        states.push(state);
      },
    );
    return { states, sleeps, reads };
  }

  it("finishes at once when the relay is already up", async () => {
    const { states, sleeps } = await watch([true]);
    expect(states).toEqual([{ state: "running" }, { state: "done" }]);
    expect(sleeps).toEqual([]);
  });

  it("keeps running, without warning, until a relay that comes up later is online", async () => {
    const { states, sleeps } = await watch([false, false, false, false, true]);
    expect(states).toEqual([{ state: "running" }, { state: "done" }]);
    expect(sleeps).toEqual(Array(4).fill(RELAY_CHECK_INTERVAL_MS));
  });

  it("warns after the grace period, then turns done once the relay connects", async () => {
    const checksBeforeWarning = RELAY_GRACE_MS / RELAY_CHECK_INTERVAL_MS;
    const { states } = await watch([...Array(checksBeforeWarning + 3).fill(false), true]);
    expect(states).toEqual([
      { state: "running" },
      { state: "warning", message: "relay offline" },
      { state: "done" },
    ]);
  });

  it("treats a failed status read as offline", async () => {
    let reads = 0;
    const states: LinkStepState[] = [];
    await watchRelay(
      {
        relayOnline: async () => {
          if (reads++ === 0) {
            throw new Error("status unavailable");
          }
          return true;
        },
        sleep: async () => {},
        active: () => true,
        now: () => 0,
      },
      "relay offline",
      (_step, state) => states.push(state),
    );
    expect(states).toEqual([{ state: "running" }, { state: "done" }]);
  });

  it("stops without reporting once the dialog closes", async () => {
    let open = true;
    const states: LinkStepState[] = [];
    let reads = 0;
    await watchRelay(
      {
        relayOnline: async () => {
          reads++;
          return false;
        },
        sleep: async () => {
          open = false;
        },
        active: () => open,
        now: () => 0,
      },
      "relay offline",
      (_step, state) => states.push(state),
    );
    expect(reads).toBe(1);
    expect(states).toEqual([{ state: "running" }]);
  });
});
