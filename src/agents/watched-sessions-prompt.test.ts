import fs from "node:fs";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as sessionReader from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildWatchedSessionsHarnessContext } from "../plugin-sdk/agent-harness-runtime.js";
import {
  handleSessionStateSessionReset,
  registerMainSessionGroupWatch,
} from "../sessions/session-state-events.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import * as stateRead from "../state/openclaw-state-db-readonly.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  buildWatchedSessionsPromptLines,
  prepareWatchedSessionsPrompt as prepareWatchedSessionsPromptSync,
  prepareWatchedSessionsPromptAsync,
} from "./watched-sessions-prompt.js";

const prepareWatchedSessionsPrompt = (
  params: Parameters<typeof prepareWatchedSessionsPromptSync>[0],
) => prepareWatchedSessionsPromptAsync({ ...params, assertCurrent: () => {} });

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-watched-sessions-");
const mainSessionKey = "agent:main:main";
const sessionReadTools = ["sessions_history", "sessions_search", "sessions_list"];

function stubStateDir() {
  const stateDir = sessionDirs.make();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
}

async function watchGroup(sessionKey: string) {
  expect(await registerMainSessionGroupWatch({ sessionKey, agentId: "main" })).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("prepareWatchedSessionsPrompt", () => {
  it("returns key-sorted watched sessions with store-derived titles", async () => {
    stubStateDir();
    await watchGroup("agent:main:telegram:group:beta");
    await watchGroup("agent:main:telegram:group:alpha:topic:7");
    await upsertSessionEntryCore(
      { sessionKey: "agent:main:telegram:group:beta" },
      { sessionId: "session-beta", displayName: "Family group", updatedAt: 1 },
    );

    const prepared = await prepareWatchedSessionsPrompt({
      enabled: true,
      sessionKey: mainSessionKey,
      toolNames: sessionReadTools,
    });

    expect(prepared).toEqual({
      sessions: [
        { key: "agent:main:telegram:group:alpha:topic:7" },
        { key: "agent:main:telegram:group:beta", title: "Family group" },
      ],
      hiddenCount: 0,
      readToolNames: ["sessions_history", "sessions_search"],
      listToolAvailable: true,
    });
  });

  it("caps rendered rows and reports the overflow count", async () => {
    stubStateDir();
    for (let index = 0; index < 23; index += 1) {
      await watchGroup(`agent:main:telegram:group:room-${String(index).padStart(2, "0")}`);
    }

    await upsertSessionEntryCore(
      { sessionKey: "agent:main:telegram:group:room-00" },
      { sessionId: "golden-title", displayName: "A".repeat(79) + "🦞tail", updatedAt: 1 },
    );
    const input = { enabled: true, sessionKey: mainSessionKey, toolNames: ["sessions_history"] };
    const sql = observeMainThreadSql();
    let prepared;
    try {
      // The released sync implementation is the pre-cutover golden and proves
      // this instrumentation sees both original reads on the caller thread.
      const original = prepareWatchedSessionsPromptSync(input);
      expect(sql.count()).toBeGreaterThan(0);
      sql.clear();
      prepared = await prepareWatchedSessionsPrompt(input);
      sql.expectIdle();
      expect(buildWatchedSessionsPromptLines(prepared).join("\n")).toBe(
        buildWatchedSessionsPromptLines(original).join("\n"),
      );
    } finally {
      sql.restore();
    }

    expect(prepared?.sessions).toHaveLength(20);
    expect(prepared?.sessions[0]?.title).toBe("A".repeat(79));
    expect(prepared?.hiddenCount).toBe(3);
    expect(prepared?.sessions[0]?.key).toBe("agent:main:telegram:group:room-00");
    expect(prepared?.readToolNames).toEqual(["sessions_history"]);
    expect(prepared?.listToolAvailable).toBe(false);
  });

  it("keeps the section for sandboxed sessions only when the clamp allows non-spawned reads", async () => {
    stubStateDir();
    await watchGroup("agent:main:telegram:group:beta");
    const base = {
      enabled: true,
      sessionKey: mainSessionKey,
      sandboxed: true,
      toolNames: sessionReadTools,
    };

    expect(await prepareWatchedSessionsPrompt({ ...base, config: {} })).toBe(undefined);
    expect(
      (
        await prepareWatchedSessionsPrompt({
          ...base,
          config: { agents: { defaults: { sandbox: { sessionToolsVisibility: "all" } } } },
        })
      )?.sessions,
    ).toHaveLength(1);
  });

  it("returns undefined when disabled, keyless, non-main, toolless, or unwatched", async () => {
    stubStateDir();
    await watchGroup("agent:main:telegram:group:beta");
    const base = { enabled: true, sessionKey: mainSessionKey, toolNames: sessionReadTools };

    expect(await prepareWatchedSessionsPrompt({ ...base, enabled: false })).toBe(undefined);
    expect(await prepareWatchedSessionsPrompt({ ...base, sessionKey: undefined })).toBe(undefined);
    expect(
      await prepareWatchedSessionsPrompt({ ...base, sessionKey: "agent:main:subagent:worker" }),
    ).toBe(undefined);
    expect(
      await prepareWatchedSessionsPrompt({ ...base, sessionKey: "agent:main:telegram:group:beta" }),
    ).toBe(undefined);
    expect(await prepareWatchedSessionsPrompt({ ...base, toolNames: ["sessions_list"] })).toBe(
      undefined,
    );
    expect(await prepareWatchedSessionsPrompt({ ...base, sessionKey: "agent:other:main" })).toBe(
      undefined,
    );
  });

  it.each(["authority", "watch", "watch-final", "sandbox", "sandbox-cleanup", "store"] as const)(
    "revalidates %s while worker facts are loading",
    async (change) => {
      stubStateDir();
      await watchGroup("agent:main:telegram:group:beta");
      const sandbox: { sessionToolsVisibility: "all" | "spawned" } = {
        sessionToolsVisibility: "all",
      };
      const config: OpenClawConfig = { agents: { defaults: { sandbox } } };
      let active = true;
      let reads = 0;
      const read = stateRead.executeExistingOpenClawStateRead;
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
      vi.spyOn(stateRead, "executeExistingOpenClawStateRead").mockImplementation(
        async (...args) => {
          const result = await read(...args);
          if (args[1].type === "sessionState.ambientTargets") {
            reads += 1;
            if (change === "watch-final" && reads === 2) {
              await handleSessionStateSessionReset(mainSessionKey);
            }
            if (change === "authority") {
              active = false;
            }
            if (change === "watch") {
              await handleSessionStateSessionReset(mainSessionKey);
            }
            if (change === "sandbox") {
              sandbox.sessionToolsVisibility = "spawned";
            }
            // Mutating ambient process selection must not retarget captured readers.
            if (change === "store") {
              stubStateDir();
            }
          }
          return result;
        },
      );
      const pending = prepareWatchedSessionsPromptAsync({
        enabled: true,
        config,
        sessionKey: mainSessionKey,
        sandboxed: true,
        toolNames: sessionReadTools,
        assertCurrent: () => {
          if (!active) {
            throw new Error("caller revoked");
          }
        },
      });
      if (change === "authority") {
        await expect(pending).rejects.toThrow("caller revoked");
      } else if (change === "store") {
        expect((await pending)?.sessions).toEqual([{ key: "agent:main:telegram:group:beta" }]);
      } else {
        await expect(pending).resolves.toBeUndefined();
      }
    },
  );

  it("rejects replacing the title database at its captured path during a worker read", async () => {
    stubStateDir();
    const key = "agent:main:telegram:group:beta";
    await watchGroup(key);
    await upsertSessionEntryCore(
      { sessionKey: key },
      { sessionId: "before-replacement", displayName: "Original", updatedAt: 1 },
    );
    const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const originalPath = `${storePath}.original`;
    const read = stateRead.executeExistingOpenClawStateRead;
    let replaced = false;
    vi.spyOn(stateRead, "executeExistingOpenClawStateRead").mockImplementation(async (...args) => {
      const result = await read(...args);
      if (args[1].type === "sessionState.ambientTargets" && !replaced) {
        fs.renameSync(storePath, originalPath);
        fs.writeFileSync(storePath, "replacement must never be opened");
        replaced = true;
      }
      return result;
    });
    try {
      await expect(
        prepareWatchedSessionsPrompt({
          enabled: true,
          sessionKey: mainSessionKey,
          toolNames: sessionReadTools,
        }),
      ).rejects.toThrow("Watched-session title store changed");
    } finally {
      if (replaced) {
        fs.unlinkSync(storePath);
        fs.renameSync(originalPath, storePath);
      }
    }
  });

  it("renders the harness context block plugin-owned runtimes inject per turn", async () => {
    stubStateDir();
    await watchGroup("agent:main:telegram:group:beta");

    const block = buildWatchedSessionsHarnessContext({
      sessionKey: mainSessionKey,
      toolNames: ["sessions_history"],
    });

    expect(block).toBe(
      [
        "## Watched Sessions",
        "Group/topic sessions this session ambiently watches. Readable now (read-only) via sessions_history.",
        "- agent:main:telegram:group:beta",
      ].join("\n"),
    );
    expect(buildWatchedSessionsHarnessContext({ sessionKey: mainSessionKey, toolNames: [] })).toBe(
      undefined,
    );
  });
});
