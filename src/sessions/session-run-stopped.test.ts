import { afterEach, describe, expect, it } from "vitest";
import type { PluginHookRunStoppedEvent } from "../plugins/hook-run-stopped.types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import {
  invalidateSessionRunStopIntents,
  notifySessionRunStopped,
  registerSessionRunStopInvalidator,
} from "./session-run-stopped.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("notifySessionRunStopped", () => {
  it("awaits durable intent invalidation and propagates a failed journal write", async () => {
    let finish!: () => void;
    const durable = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const release = registerSessionRunStopInvalidator(() => durable);
    const intent = {
      source: "client-run" as const,
      sessions: [{ sessionKey: "agent:main:a" }],
      runIds: ["retired-run"],
    };
    let accepted = false;
    const pending = invalidateSessionRunStopIntents(intent).then(() => {
      accepted = true;
    });
    await Promise.resolve();
    expect(accepted).toBe(false);
    finish();
    await pending;
    expect(accepted).toBe(true);
    release();
    const fail = registerSessionRunStopInvalidator(async () => {
      throw new Error("disk unavailable");
    });
    await expect(invalidateSessionRunStopIntents(intent)).rejects.toThrow("disk unavailable");
    fail();
  });
  it("starts run_stopped handlers before returning and never fails the Stop", async () => {
    const seen: PluginHookRunStoppedEvent[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "run_stopped",
          pluginId: "observer",
          handler: async (event) => {
            seen.push(event as PluginHookRunStoppedEvent);
            await slow;
          },
        },
        {
          hookName: "run_stopped",
          pluginId: "broken",
          handler: () => {
            throw new Error("handler failed");
          },
        },
      ]),
    );

    expect(() =>
      notifySessionRunStopped({
        source: "channel-user",
        sessions: [
          { agentId: "main", sessionKey: "agent:main:a" },
          { agentId: "main", sessionKey: "agent:main:a" },
          { sessionKey: "agent:main:no-agent" },
        ],
        runIds: [" run-1 ", "run-1", "", "run-2"],
      }),
    ).not.toThrow();

    // Synchronous start lets consumers act before the stopped run's own completion arrives.
    expect(seen).toEqual([
      {
        source: "channel",
        sessions: [{ agentId: "main", sessionKey: "agent:main:a" }],
        runIds: ["run-1", "run-2"],
      },
    ]);
    release();
  });
});
