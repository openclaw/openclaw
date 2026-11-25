import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { beginSessionEffect, captureSessionTarget } from "./session-controller.lifecycle.js";
import { captureSessionControllerStop, stopSession } from "./session-controller.stop.js";

it("stops interrupting captured effects when the requester loses authority", async () => {
  const target = captureSessionTarget({
    storeScope: "/synthetic/stop-authority/" + randomUUID(),
    sessionKey: "agent:main:stop-authority",
    incarnation: randomUUID(),
    agentId: "main",
  });
  let current = true;
  const first = await beginSessionEffect({
    target,
    onInterrupt: () => {
      current = false;
    },
  });
  const secondInterrupt = vi.fn();
  const second = await beginSessionEffect({ target, onInterrupt: secondInterrupt });
  try {
    await expect(
      stopSession({
        source: "restart",
        capture: captureSessionControllerStop({ targets: [target] }),
        assertCurrent: () => {
          if (!current) {
            throw new Error("requester authority changed");
          }
        },
      }).completed,
    ).rejects.toThrow("requester authority changed");
    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(true);
    expect(secondInterrupt).not.toHaveBeenCalled();
  } finally {
    first.release();
    second.release();
    await Promise.all([first.released, second.released]);
  }
});
