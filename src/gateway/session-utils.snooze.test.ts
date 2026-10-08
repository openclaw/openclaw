// Session lists project snooze metadata for roots without changing server-side membership.
import "./session-utils-provider.test-support.js";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import { listSessionFixture } from "./session-list.test-support.js";
import {
  closeSessionSqliteDatabasesForTest,
  createModelDefaultsConfig,
} from "./session-utils.test-support.js";

const { resetSessionProviderArtifacts } = await import("./session-utils-provider.test-support.js");

describe("session list snooze projection", () => {
  beforeEach(resetSessionProviderArtifacts);
  afterAll(closeSessionSqliteDatabasesForTest);

  test.each([["agent:main:dashboard:pinned", { parentSessionKey: "agent:main:main" }]])(
    "session lists separate archived rows and sort pinned %s first",
    async (pinnedKey, lineage) => {
      const cfg = createModelDefaultsConfig({ primary: "openai/gpt-5.4" });
      const store: Record<string, SessionEntry> = {
        recent: { sessionId: "recent", updatedAt: 30 },
        [pinnedKey]: {
          sessionId: "pinned",
          updatedAt: 10,
          pinnedAt: 40,
          snoozedUntil: 1_800_000_000_000,
          snoozedAt: 40,
          ...lineage,
        },
        archived: {
          sessionId: "archived",
          updatedAt: 20,
          archivedAt: 50,
          archiveReason: "active-session-cap",
        },
      } satisfies Record<string, SessionEntry>;

      const active = await listSessionFixture({ cfg, storePath: "", store, opts: {} });
      expect(active.sessions.map((session) => session.key)).toEqual([pinnedKey, "recent"]);
      expect(active.sessions[0]).toMatchObject({
        pinned: true,
        pinnedAt: 40,
        snoozedUntil: 1_800_000_000_000,
        snoozedAt: 40,
        archived: false,
      });

      const archived = await listSessionFixture({
        cfg,
        storePath: "",
        store,
        opts: { archived: true },
      });
      expect(archived.sessions).toMatchObject([
        {
          key: "archived",
          archived: true,
          archivedAt: 50,
          archiveReason: "active-session-cap",
          pinned: false,
        },
      ]);

      const all = await listSessionFixture({
        cfg,
        storePath: "",
        store,
        opts: { archived: "all" },
      });
      expect(all.sessions.map((session) => session.key)).toEqual([pinnedKey, "recent", "archived"]);
    },
  );
});
