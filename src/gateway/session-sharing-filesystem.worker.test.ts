import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { SessionActivitySummaryService } from "./session-activity-summaries.js";
import {
  createActivityRecapSessionFixture,
  recapRpc,
  scope,
  target,
} from "./session-activity-summaries.test-support.js";

/** Count every exported sync fs call on the request thread; retain stacks, never path arguments. */
function observeSyncFilesystem() {
  const calls: Array<{ operation: string; stack: string }> = [];
  const restores: Array<() => void> = [];
  const stackLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 50;
  let depth = 0;
  const wrap = (owner: object, name: string, operation: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    const original: unknown = descriptor?.value;
    if (!descriptor || typeof original !== "function") {
      return;
    }
    const wrapped = function (this: unknown, ...args: unknown[]) {
      if (depth === 0) {
        calls.push({ operation, stack: new Error().stack ?? "" });
      }
      depth++;
      try {
        return Reflect.apply(original, this, args);
      } finally {
        depth--;
      }
    };
    Object.assign(wrapped, original);
    Object.defineProperty(owner, name, { ...descriptor, value: wrapped });
    restores.push(() => Object.defineProperty(owner, name, descriptor));
  };
  for (const name of Object.keys(fs)) {
    if (name.endsWith("Sync")) {
      wrap(fs, name, name);
    }
  }
  wrap(fs.realpathSync, "native", "realpathSync.native");
  syncBuiltinESMExports();
  return {
    calls,
    restore() {
      for (const restore of restores.toReversed()) {
        restore();
      }
      Error.stackTraceLimit = stackLimit;
      syncBuiltinESMExports();
    },
  };
}

function request(cfg: OpenClawConfig) {
  const ensure = vi.fn<SessionActivitySummaryService["ensure"]>(async () => ({
    state: "unavailable",
  }));
  const context = createDirectChatContext({
    getRuntimeConfig: () => cfg,
    sessionActivitySummaries: {
      ensure,
      beginCompletion: () => undefined,
      handleEvent() {},
      handleLifecycle() {},
      async dispose() {},
    },
  });
  return { ...recapRpc("sessions.activitySummary.ensure", context), ensure };
}

it("prepares activity-summary sharing facts without synchronous request-thread filesystem work", async () => {
  const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
  const state = await createActivityRecapSessionFixture(cfg);
  try {
    const rpc = request(cfg);
    const observation = observeSyncFilesystem();
    try {
      await rpc.invoke({ sessions: [target] });
    } finally {
      observation.restore();
    }
    expect(rpc.respond).toHaveBeenCalledExactlyOnceWith(true, {
      sessions: [{ ...target, activitySummary: { state: "unavailable", canEnsure: true } }],
    });
    expect(rpc.ensure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(target),
      expect.objectContaining({ sessionId: scope.sessionId }),
    );
    expect(
      observation.calls.filter(({ stack }) =>
        /session-sharing-(?:preparation|facts-read)/.test(stack),
      ),
    ).toEqual([]);
  } finally {
    clearRuntimeConfigSnapshot();
    await state.cleanup();
  }
});
