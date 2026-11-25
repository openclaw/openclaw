import { afterEach, describe, expect, it } from "vitest";
import type { PluginHookRunStoppedEvent } from "../plugins/hook-run-stopped.types.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-helpers.js";
import { notifySessionRunStopped } from "./session-run-stopped.js";

afterEach(() => {
  resetGlobalHookRunner();
});

describe("notifySessionRunStopped", () => {
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
