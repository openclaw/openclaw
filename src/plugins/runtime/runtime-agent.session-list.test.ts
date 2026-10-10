import "../../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import { expect, it } from "vitest";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../../config/sessions/session-accessor.sqlite-participants.native.js";
import {
  closeOpenClawAgentDatabasesAsync,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

it("lists exact selected keys without losing full entry fields", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const runtime = createRuntimeAgent();
    for (const name of ["selected", "other", "alpha"]) {
      await runtime.session.upsertSessionEntry({
        agentId: "main",
        sessionKey: `agent:main:${name}`,
        entry: { sessionId: name, updatedAt: 1, category: "Team", execCwd: `/work/${name}` },
      });
    }
    const identity = { type: "agent", id: "observer" } as const;
    recordSessionParticipant(
      { agentId: "main", sessionKey: "agent:main:selected" },
      { identity, promptedAt: 1 },
    );
    expect(
      runtime.session.listSessionEntries({
        agentId: "main",
        readOnly: true,
        sessionKeys: ["agent:main:selected", "agent:main:missing", "agent:main:alpha"],
      }),
    ).toEqual([
      expect.objectContaining({
        sessionKey: "agent:main:alpha",
        entry: expect.objectContaining({
          sessionId: "alpha",
          execCwd: "/work/alpha",
          category: "Team",
        }),
      }),
      expect.objectContaining({
        sessionKey: "agent:main:selected",
        entry: expect.objectContaining({
          sessionId: "selected",
          execCwd: "/work/selected",
          category: "Team",
          participants: [{ identity }],
          participantCount: 1,
        }),
      }),
    ]);
    expect(
      runtime.session.listSessionEntries({ agentId: "main", readOnly: true, sessionKeys: [] }),
    ).toEqual([]);
    const assertions: Array<() => void> = [];
    for (const readOnly of [true, false]) {
      const selected = runtime.session.listSessionEntries({
        agentId: "main",
        readOnly,
        sessionKeys: ["agent:main:selected", "agent:main:alpha"],
        captureSource: (assertCurrent) => assertions.push(assertCurrent),
      });
      expect(selected).toEqual(
        runtime.session
          .listSessionEntries({ agentId: "main", readOnly })
          .filter(({ sessionKey }) =>
            ["agent:main:selected", "agent:main:alpha"].includes(sessionKey),
          ),
      );
      const metadata = runtime.session.listSessionEntries({
        agentId: "main",
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
    const runtime = createRuntimeAgent();
    const scope = { agentId: "main", sessionKey: "agent:main:clickclack:channel:discussion" };
    const read = runtime.session.getSessionEntryAsync;
    if (!read) {
      throw new Error("Expected the current runtime's asynchronous session reader");
    }
    const initial = { sessionId: "original", updatedAt: 100, displayName: "Original title" };
    await runtime.session.upsertSessionEntry({ ...scope, entry: initial });
    expect(await read({ ...scope, readConsistency: "latest" })).toMatchObject(initial);

    const replacement = {
      ...initial,
      sessionId: "replacement",
      displayName: "Replacement title",
    };
    replaceSessionEntrySync(scope, replacement);
    expect(await read({ ...scope, readConsistency: "latest" })).toMatchObject(replacement);
  });
});
