import { describe, expect, it, vi } from "vitest";
import type { DedupeEntry } from "../server-shared.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";

function prepareReplayOnly(dedupe: Map<string, DedupeEntry>) {
  const respond = vi.fn();
  const prepared = prepareAgentRequestPreflight({
    params: {
      message: "recover this run",
      idempotencyKey: "run-recovery",
      replayOnly: true,
    },
    respond,
    context: {
      dedupe,
      getRuntimeConfig: () => ({}),
    },
    client: undefined,
  } as unknown as Parameters<typeof prepareAgentRequestPreflight>[0]);
  return { prepared, respond };
}

describe("agent replay-only preflight", () => {
  it("returns the exact cached terminal response", () => {
    const payload = {
      runId: "run-recovery",
      status: "ok",
      result: { payloads: [{ text: "original result" }] },
    };
    const { prepared, respond } = prepareReplayOnly(
      new Map([
        [
          "agent:run-recovery",
          {
            ts: Date.now(),
            ok: true,
            payload,
          },
        ],
      ]),
    );

    expect(prepared).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(true, payload, undefined, { cached: true });
  });

  it("fails closed on a cache miss without admitting a new run", () => {
    const { prepared, respond } = prepareReplayOnly(new Map());

    expect(prepared).toBeUndefined();
    expect(respond).toHaveBeenCalledWith(
      false,
      { runId: "run-recovery", status: "unavailable" },
      expect.objectContaining({
        code: "AGENT_RESULT_NOT_FOUND",
        message: expect.stringContaining("did not start a new run"),
      }),
      { runId: "run-recovery" },
    );
  });
});
