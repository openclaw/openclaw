import { expect, it, onTestFinished } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  requestContext,
  sessionReadHandlers,
} from "./server-methods/sessions-read-cache.test-support.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import {
  createSessionRowProjectionFixture,
  requestSessionRow,
} from "./session-row-projection.test-support.js";
import type { SessionsListResult } from "./session-utils.types.js";

it.each([false, true])(
  "keeps authorized unread totals current before pagination (serialized=%s)",
  async (acceptsSerializedJson) => {
    const cfg = { agents: { entries: { main: {}, work: {} } } };
    const root = "agent:main:dashboard:root";
    const child = "agent:work:dashboard:child";
    const row = (sessionId: string, fields: Partial<SessionEntry> = {}): SessionEntry => ({
      sessionId,
      updatedAt: 200,
      createdAt: 100,
      lastActivityAt: 101,
      createdActor: { type: "human", source: "profile", id: "reader" },
      visibility: "draft",
      ...fields,
    });
    const store = {
      [root]: row("root"),
      [child]: row("child", { spawnedBy: root, lastReadAt: 101, markedUnreadAt: 102 }),
      "agent:main:subagent:execution": row("execution", { spawnedBy: root }),
      "agent:main:dashboard:archived": row("archived", { archivedAt: 150 }),
      "agent:main:dashboard:equal": row("equal", { lastReadAt: 101 }),
      "agent:main:dashboard:legacy": row("legacy", { createdAt: undefined }),
      "agent:main:dashboard:private": row("private", {
        createdActor: { type: "human", source: "profile", id: "other" },
      }),
    };
    const projection = createSessionRowProjectionFixture({ cfg, store });
    onTestFinished(() => projection.dispose());
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const client = createOperatorClient({ profileId: "reader", scopes: ["operator.read"] });
    client.preparedSessionProfile = {
      profileId: "reader",
      aliases: new Set(["reader"]),
      role: null,
    };
    const list = async (offset = 0, unreadOnly = true) => {
      let result: SessionsListResult | undefined;
      await requestSessionRow(
        (options) => sessionReadHandlers["sessions.list"]!({ ...options, acceptsSerializedJson }),
        context,
        "sessions.list",
        {
          unreadOnly,
          excludeSubagents: true,
          excludeSystem: true,
          archived: false,
          limit: 1,
          offset,
        },
        (ok, value, error) => {
          expect(error).toBeUndefined();
          expect(ok).toBe(true);
          result = value as SessionsListResult;
        },
        client,
      );
      return result!;
    };
    const first = await list();
    expect(first.totalCount).toBe(2);
    expect(first.sessions).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    // Normal and unread inventories must never share a retained selection.
    expect((await list(0, false)).totalCount).toBe(4);
    expect((await list()).totalCount).toBe(2);
    const second = await list(1);
    expect(second.totalCount).toBe(2);
    expect(new Set([...first.sessions, ...second.sessions].map((entry) => entry.key))).toEqual(
      new Set([root, child]),
    );

    projection.setEntry(root, { ...store[root], lastReadAt: 101 });
    projection.setEntry(child, { ...store[child], markedUnreadAt: undefined });
    expect(await list()).toMatchObject({ totalCount: 0, sessions: [], hasMore: false });
    // A later interaction remains unread; reads never consume activity not yet displayed.
    projection.setEntry(root, { ...store[root], lastReadAt: 101, lastInteractionAt: 102 });
    expect(await list()).toMatchObject({ totalCount: 1, sessions: [{ key: root }] });
  },
);
