import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import {
  getSubagentDepthFromSessionStore,
  getSubagentDepthFromSessionStoreInWorker,
} from "./subagent-depth.js";
import { createSessionCapabilityLookup } from "./subagent-session-store.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    cleanup();
  }),
);

async function depthStore(
  entries: Array<[string, { spawnDepth?: number; spawnedBy?: string }, string?]>,
  fixed = false,
) {
  const store = path.join(
    tempDirs.make("subagent-depth-"),
    fixed ? "sessions.sqlite" : "sessions-{agentId}.json",
  );
  for (const [sessionKey, fields, owner] of entries) {
    const agentId = expectDefined(owner ?? sessionKey.split(":")[1], "fixture owner");
    await replaceSessionEntry(
      { agentId, sessionKey, storePath: store.replaceAll("{agentId}", agentId) },
      { sessionId: sessionKey, updatedAt: Date.now(), ...fields },
    );
  }
  return store;
}

describe("getSubagentDepthFromSessionStore", () => {
  it("ignores non-decimal and unsafe stored spawnDepth strings", () => {
    const key = "agent:main:subagent:flat";
    for (const spawnDepth of ["1e3", "0x10", "1.5", "9007199254740993"]) {
      const depth = getSubagentDepthFromSessionStore(key, {
        store: createSessionCapabilityLookup({
          [key]: { spawnDepth },
        }),
      });
      expect(depth).toBe(1);
    }
  });

  it("ignores parentSessionKey threading when resolving spawn depth", () => {
    const store = createSessionCapabilityLookup({
      "agent:main:main": {},
      "agent:main:dashboard:operator": { spawnDepth: 0, parentSessionKey: "agent:main:main" },
      "agent:main:dashboard:legacy": { parentSessionKey: "agent:main:main" },
    });
    expect(getSubagentDepthFromSessionStore("agent:main:dashboard:operator", { store })).toBe(0);
    expect(getSubagentDepthFromSessionStore("agent:main:dashboard:legacy", { store })).toBe(0);
  });

  it("resolves prefixed store keys when caller key omits the agent prefix", async () => {
    const store = await depthStore([["agent:main:subagent:flat", { spawnDepth: 2 }]]);
    expect(
      await getSubagentDepthFromSessionStoreInWorker("subagent:flat", {
        cfg: { session: { store } },
      }),
    ).toBe(2);
  });

  it("reads a bare fixed-store key through its persisted owner", async () => {
    const store = await depthStore([["global", { spawnDepth: 2 }, "ops"]], true);
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
      session: { scope: "global", store },
    } satisfies OpenClawConfig;

    expect(await getSubagentDepthFromSessionStoreInWorker("global", { cfg })).toBe(2);
  });

  it("resolves a cross-agent parent outside the supplied child store", async () => {
    const parentKey = "agent:main:dashboard:parent";
    const store = await depthStore([[parentKey, { spawnDepth: 2 }]]);

    const depth = await getSubagentDepthFromSessionStoreInWorker("agent:work:dashboard:child", {
      cfg: { session: { store } },
      store: createSessionCapabilityLookup({
        "agent:work:dashboard:child": { spawnedBy: parentKey },
      }),
    });

    expect(depth).toBe(3);
  });

  it("keeps agent-scoped views separate for a fixed shared store", async () => {
    const childKey = "agent:ops:dashboard:child";
    const parentKey = "agent:research:dashboard:parent";
    const store = await depthStore(
      [
        [childKey, { spawnedBy: parentKey }],
        [parentKey, { spawnDepth: 2 }],
      ],
      true,
    );

    expect(
      await getSubagentDepthFromSessionStoreInWorker(childKey, {
        cfg: {
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
          session: { store },
        },
      }),
    ).toBe(3);
  });
});

describe("resolveAgentTimeoutMs", () => {
  it("resolves unlimited config timeoutSeconds", () => {
    const cfg = { agents: { defaults: { timeoutSeconds: 0 } } } satisfies OpenClawConfig;
    expect(resolveAgentTimeoutMs({ cfg })).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("uses a timer-safe sentinel for no-timeout overrides", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 0 })).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ overrideMs: 0 })).toBe(MAX_TIMER_TIMEOUT_MS);
  });

  it("clamps very large timeout overrides to timer-safe values", () => {
    expect(resolveAgentTimeoutMs({ overrideSeconds: 9_999_999 })).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveAgentTimeoutMs({ overrideMs: 9_999_999_999 })).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
