import fs from "node:fs";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import * as configSnapshot from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as sessionReader from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildWatchedSessionsHarnessContext as harnessContext } from "../plugin-sdk/agent-harness-runtime.js";
import * as sessionState from "../sessions/session-state-events.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import * as stateRead from "../state/openclaw-state-db-readonly.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import * as sessionCleanup from "../test-utils/session-state-cleanup.js";
import {
  buildWatchedSessionsPromptLines as renderPrompt,
  prepareWatchedSessionsPrompt as prepareSync,
  prepareWatchedSessionsPromptAsync as prepareAsync,
} from "./watched-sessions-prompt.js";

const sessionDirs = sessionCleanup.useSessionStoreTempDirs(afterAll, "openclaw-watched-sessions-");
const mainSessionKey = "agent:main:main";
const groupKey = (name = "beta") => `agent:main:telegram:group:${name}`;
const sessionReadTools = ["sessions_history", "sessions_search", "sessions_list"];
const promptInput = { enabled: true, sessionKey: mainSessionKey, toolNames: sessionReadTools };
const preparePrompt = (params: Partial<Parameters<typeof prepareSync>[0]> = {}) =>
  prepareAsync({ ...promptInput, ...params, assertCurrent: () => {} });

function stubStateDir() {
  vi.stubEnv("OPENCLAW_STATE_DIR", sessionDirs.make());
}

const sandboxConfig = (sandbox: { sessionToolsVisibility: "all" | "spawned" }): OpenClawConfig => ({
  agents: { defaults: { sandbox } },
});

async function watchGroup(sessionKey = groupKey(), displayName?: string) {
  expect(await sessionState.registerMainSessionGroupWatch({ sessionKey, agentId: "main" })).toBe(
    true,
  );
  if (displayName) {
    await upsertSessionEntryCore(
      { sessionKey },
      { sessionId: "test-session", displayName, updatedAt: 1 },
    );
  }
}

function afterAmbientRead(change: (reads: number) => void | Promise<void>) {
  const read = stateRead.executeExistingOpenClawStateRead;
  let reads = 0;
  vi.spyOn(stateRead, "executeExistingOpenClawStateRead").mockImplementation(async (...args) => {
    const result = await read(...args);
    if (args[1].type === "sessionState.ambientTargets") {
      await change(++reads);
    }
    return result;
  });
}

afterEach(async () => {
  await sessionCleanup.drainSessionStateForTest();
  vi.restoreAllMocks();
  configSnapshot.clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  stubStateDir();
  configSnapshot.setRuntimeConfigSnapshot({});
});

it("sorts and caps watched sessions with store-derived titles and overflow", async () => {
  for (let index = 22; index >= 0; index -= 1) {
    await watchGroup(
      groupKey(`room-${String(index).padStart(2, "0")}`),
      index === 0 ? "A".repeat(79) + "🦞tail" : undefined,
    );
  }

  const input = { ...promptInput, toolNames: ["sessions_history"] };
  const sql = observeMainThreadSql();
  let prepared;
  try {
    // The sync golden also proves the SQL instrumentation observes caller-thread reads.
    const original = prepareSync(input);
    expect(sql.count()).toBeGreaterThan(0);
    sql.clear();
    prepared = await preparePrompt(input);
    sql.expectIdle();
    expect(renderPrompt(prepared)).toEqual(renderPrompt(original));
  } finally {
    sql.restore();
  }

  expect(prepared?.sessions).toHaveLength(20);
  expect(prepared?.sessions[0]).toEqual({ title: "A".repeat(79), key: groupKey("room-00") });
  expect(prepared?.sessions[1]).toEqual({ key: groupKey("room-01") });
  expect(prepared?.sessions.map(({ key }) => key)).toEqual(
    Array.from({ length: 20 }, (_, index) => groupKey(`room-${String(index).padStart(2, "0")}`)),
  );
  expect(prepared).toMatchObject({
    hiddenCount: 3,
    readToolNames: ["sessions_history"],
    listToolAvailable: false,
  });
  expect(await preparePrompt()).toMatchObject({
    readToolNames: ["sessions_history", "sessions_search"],
    listToolAvailable: true,
  });
});

it("keeps sandboxed watches only when non-spawned reads are allowed", async () => {
  await watchGroup();
  expect(await preparePrompt({ sandboxed: true, config: {} })).toBe(undefined);
  const prepared = await preparePrompt({
    sandboxed: true,
    config: sandboxConfig({ sessionToolsVisibility: "all" }),
  });
  expect(prepared?.sessions).toHaveLength(1);
  expect(prepared?.hiddenCount).toBe(0);
});

it.each([
  { enabled: false },
  { sessionKey: undefined },
  { sessionKey: "agent:main:subagent:worker" },
  { sessionKey: groupKey() },
  { toolNames: ["sessions_list"] },
  { sessionKey: "agent:other:main" },
])("omits inaccessible or unwatched sessions: %j", async (input) => {
  await watchGroup();
  expect(await preparePrompt(input)).toBeUndefined();
});

it.each(["authority", "watch", "watch-final", "sandbox", "sandbox-cleanup", "store"] as const)(
  "revalidates %s while worker facts are loading",
  async (change) => {
    await watchGroup();
    const sandbox: { sessionToolsVisibility: "all" | "spawned" } = {
      sessionToolsVisibility: "all",
    };
    let active = true;
    const withReader = sessionReader.withSessionStoreReaderInWorker;
    if (change === "sandbox-cleanup") {
      vi.spyOn(sessionReader, "withSessionStoreReaderInWorker").mockImplementation(
        async (...args) => {
          const result = await withReader(...args);
          sandbox.sessionToolsVisibility = "spawned";
          return result;
        },
      );
    }
    afterAmbientRead(async (reads) => {
      if (change === "watch" || (change === "watch-final" && reads === 2)) {
        await sessionState.handleSessionStateSessionReset(mainSessionKey);
      }
      if (change === "authority") {
        active = false;
      }
      if (change === "sandbox") {
        sandbox.sessionToolsVisibility = "spawned";
      }
      // Ambient process selection must not retarget captured readers.
      if (change === "store") {
        stubStateDir();
      }
    });
    const pending = prepareAsync({
      ...promptInput,
      config: sandboxConfig(sandbox),
      sandboxed: true,
      assertCurrent: () => {
        if (!active) {
          throw new Error("caller revoked");
        }
      },
    });
    if (change === "authority") {
      await expect(pending).rejects.toThrow("caller revoked");
    } else if (change === "store") {
      expect((await pending)?.sessions).toEqual([{ key: groupKey() }]);
    } else {
      await expect(pending).resolves.toBeUndefined();
    }
  },
);

it("rejects title database replacement during a worker read", async () => {
  await watchGroup(groupKey(), "Original");
  const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  const originalPath = `${storePath}.original`;
  let replaced = false;
  afterAmbientRead(() => {
    if (!replaced) {
      fs.renameSync(storePath, originalPath);
      fs.writeFileSync(storePath, "replacement must never be opened");
      replaced = true;
    }
  });
  try {
    await expect(preparePrompt()).rejects.toThrow("Watched-session title store changed");
  } finally {
    if (replaced) {
      fs.unlinkSync(storePath);
      fs.renameSync(originalPath, storePath);
    }
  }
});

it("renders the per-turn harness context block", async () => {
  await watchGroup();

  expect(harnessContext({ ...promptInput, toolNames: ["sessions_history"] })).toBe(
    `## Watched Sessions\nGroup/topic sessions this session ambiently watches. Readable now (read-only) via sessions_history.\n- ${groupKey()}`,
  );
  expect(harnessContext({ sessionKey: mainSessionKey, toolNames: [] })).toBeUndefined();
});
