// Issue #91613 run-layer wiring: the keyless-inherited refusal now lives in resolveDeliveryTarget
// (returns ok:false), so resolveCronDeliveryContext simply passes it through — no flag the caller
// must remember to check. It also resolves the job's OWN session identity (sessionTarget takes
// precedence over sessionKey, like delivery preview) so a session-scoped cron is not misread as
// keyless. The resolver seam is mocked so this exercises the run-layer wiring in isolation.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { CronJob } from "../types.js";

const resolveDeliveryTargetMock = vi.hoisted(() => vi.fn());
vi.mock("./run-delivery.runtime.js", () => ({
  resolveDeliveryTarget: resolveDeliveryTargetMock,
}));

import { resolveCronDeliveryContext } from "./run.js";

// An isolated cron defaults to announce/"last" delivery, so it reaches the resolver.
const ISOLATED_JOB = {
  sessionTarget: "isolated",
  payload: { kind: "agentTurn" },
} as unknown as CronJob;
const CFG = {} as OpenClawConfig;

describe("resolveCronDeliveryContext — issue #91613 keyless-inherited wiring", () => {
  it("passes through the resolver's ok:false refusal for a keyless-inherited target", async () => {
    resolveDeliveryTargetMock.mockResolvedValueOnce({
      ok: false,
      channel: "alpha",
      to: undefined,
      mode: "implicit",
      error: new Error(
        "Refusing implicit isolated cron delivery: the target would be inherited from the shared " +
          "agent-main session bucket's last recipient ... can deliver to the wrong room ...",
      ),
    });

    const result = await resolveCronDeliveryContext({
      cfg: CFG,
      job: ISOLATED_JOB,
      agentId: "agent-x",
    });

    expect(result.resolvedDelivery.ok).toBe(false);
    if (!result.resolvedDelivery.ok) {
      expect(result.resolvedDelivery.error.message).toMatch(
        /shared agent-main|inherited|wrong room/i,
      );
    }
  });

  it("delivers normally when the resolver resolves an explicit target", async () => {
    resolveDeliveryTargetMock.mockResolvedValueOnce({
      ok: true,
      channel: "alpha",
      to: "room:cron-own",
      mode: "explicit",
    });

    const result = await resolveCronDeliveryContext({
      cfg: CFG,
      job: ISOLATED_JOB,
      agentId: "agent-x",
    });

    expect(result.resolvedDelivery.ok).toBe(true);
    if (result.resolvedDelivery.ok) {
      expect(result.resolvedDelivery.to).toBe("room:cron-own");
    }
  });

  it("resolves the job's sessionTarget into the resolver's sessionKey so a session-scoped cron is not misread as keyless", async () => {
    resolveDeliveryTargetMock.mockResolvedValueOnce({
      ok: true,
      channel: "alpha",
      to: "room:session-scoped",
      mode: "implicit",
    });

    const sessionScopedJob = {
      sessionTarget: "session:my-session",
      payload: { kind: "agentTurn" },
    } as unknown as CronJob;

    await resolveCronDeliveryContext({ cfg: CFG, job: sessionScopedJob, agentId: "agent-x" });

    expect(resolveDeliveryTargetMock).toHaveBeenCalledWith(
      CFG,
      "agent-x",
      expect.objectContaining({ sessionKey: "my-session" }),
    );
  });
});
