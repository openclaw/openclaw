import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { selectPluginStateEntry, upsertPluginStateEntry } from "./plugin-state-store.kernel.js";

it("refuses NUL plugin keys before PostgreSQL reads or writes", () => {
  const db = new DatabaseSync(":memory:");
  Object.defineProperty(db, Symbol.for("openclaw.postgres-sync-connection"), { value: true });
  try {
    const scope = { pluginId: "test", namespace: "test", key: "nul\0tail" };
    for (const run of [
      () => selectPluginStateEntry(db, { ...scope, now: 1 }),
      () =>
        upsertPluginStateEntry(db, {
          plugin_id: scope.pluginId,
          namespace: scope.namespace,
          entry_key: scope.key,
          value_json: "{}",
          created_at: 1,
          expires_at: null,
        }),
    ]) {
      expect(run).toThrow(
        expect.objectContaining({
          code: "PLUGIN_STATE_INVALID_INPUT",
          message: "PostgreSQL plugin state keys cannot contain NUL characters.",
        }),
      );
    }
  } finally {
    db.close();
  }
});
