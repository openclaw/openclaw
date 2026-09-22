import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_CHANNELS } from "./legacy-config-migrations.channels.js";

describe("shared group history configuration", () => {
  it.each([Number.MAX_SAFE_INTEGER, 0, 7, 5000])(
    "preserves the valid saved limit %s",
    (historyLimit) => {
      const raw = { messages: { groupChat: { historyLimit, visibleReplies: "automatic" } } };
      const before = structuredClone(raw);
      const changes: string[] = [];
      for (const migration of LEGACY_CONFIG_MIGRATIONS_CHANNELS) {
        migration.apply(raw, changes);
      }
      expect(raw).toEqual(before);
      expect(changes).toEqual([]);
    },
  );
});
