import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import { assert, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../../config/sessions/session-accessor.sqlite-participants.native.js";
import {
  closeOpenClawAgentDatabasesAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withPluginRuntimePluginScope } from "./gateway-request-scope.js";
import { createRuntimeAgent } from "./runtime-agent.js";

const fields = (name: string) => ({ sessionId: name, category: "Team", execCwd: `/work/${name}` });

it("lists exact selected keys without losing full entry fields", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const { session } = createRuntimeAgent();
    for (const name of ["selected", "other", "alpha"]) {
      await session.upsertSessionEntry({
        agentId: "main",
        sessionKey: `agent:main:${name}`,
        entry: { ...fields(name), updatedAt: 1 },
      });
    }
    const identity = { type: "agent", id: "observer" } as const;
    recordSessionParticipant(
      { agentId: "main", sessionKey: "agent:main:selected" },
      { identity, promptedAt: 1 },
    );
    const list = (options: Parameters<typeof session.listSessionEntries>[0]) =>
      session.listSessionEntries({ agentId: "main", readOnly: true, ...options });
    const expected = ["alpha", "selected"].map((name) =>
      expect.objectContaining({
        sessionKey: `agent:main:${name}`,
        entry: expect.objectContaining({
          ...fields(name),
          ...(name === "selected" ? { participants: [{ identity }], participantCount: 1 } : {}),
        }),
      }),
    );
    expect(list({ sessionKeys: [] })).toEqual([]);
    const assertions: Array<() => void> = [];
    for (const readOnly of [true, false]) {
      const selected = list({
        readOnly,
        sessionKeys: ["agent:main:selected", "agent:main:missing", "agent:main:alpha"],
        captureSource: (assertCurrent) => assertions.push(assertCurrent),
      });
      expect(selected).toEqual(expected);
      expect(selected).toEqual(
        list({ readOnly }).filter(({ sessionKey }) =>
          ["agent:main:selected", "agent:main:alpha"].includes(sessionKey),
        ),
      );
      const metadata = list({
        readOnly,
        sessionKeys: ["agent:main:selected"],
        includeParticipants: false,
      });
      expect(metadata[0]?.entry).toMatchObject({ sessionId: "selected", category: "Team" });
      expect(metadata[0]?.entry.participants).toBeUndefined();
      expect(metadata[0]?.entry.participantCount).toBeUndefined();
    }
    expect(assertions).toHaveLength(2);
    assertions.forEach((assertCurrent) => expect(assertCurrent).not.toThrow());
    const pathname = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await closeOpenClawAgentDatabasesAsync();
    fs.renameSync(pathname, `${pathname}.previous`);
    fs.copyFileSync(`${pathname}.previous`, pathname);
    assertions.forEach((assertCurrent) => expect(assertCurrent).toThrow());
  });
});

it("refreshes asynchronous descriptive reads after a native session replacement", async () => {
  await withOpenClawTestState({ label: "plugin-runtime-async-session-read" }, async () => {
    setRuntimeConfigSnapshot({});
    const { session } = createRuntimeAgent();
    const scope = { agentId: "main", sessionKey: "agent:main:clickclack:channel:discussion" };
    const read = session.getSessionEntryAsync;
    assert(read, "Expected the current runtime's asynchronous session reader");
    const initial = { sessionId: "original", updatedAt: 100, displayName: "Original title" };
    await session.upsertSessionEntry({ ...scope, entry: initial });
    expect(await read({ ...scope, readConsistency: "latest" })).toMatchObject(initial);

    const replacement = {
      ...initial,
      sessionId: "replacement",
      displayName: "Replacement title",
    };
    replaceSessionEntrySync(scope, replacement);
    expect(await read({ ...scope, readConsistency: "latest" })).toMatchObject(replacement);

    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      await withPluginRuntimePluginScope({ pluginId: "session-runtime-read-warning" }, async () => {
        expect(await read(scope)).toMatchObject(replacement);
        expect(warning).not.toHaveBeenCalled();
        for (let index = 0; index < 2; index++) {
          expect(session.getSessionEntry(scope)).toMatchObject(replacement);
        }
      });
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          "runtime.agent.session.getSessionEntry is deprecated; use runtime.agent.session.getSessionEntryAsync",
        ),
        { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
      );
    } finally {
      warning.mockRestore();
    }
  });
});
