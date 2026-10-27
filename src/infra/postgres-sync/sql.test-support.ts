import { channel } from "node:diagnostics_channel";
import { vi } from "vitest";
import type { EngineConnection } from "../sql-connection.js";

export function observeStatementEvents() {
  const statements = channel("openclaw.database.statement");
  const events: unknown[] = [];
  const record = (event: unknown) => events.push(event);
  statements.subscribe(record);
  return { events, [Symbol.dispose]: () => statements.unsubscribe(record) };
}

export function failAfterStatement(
  db: Pick<EngineConnection, "exec">,
  command: string,
  error: Error,
) {
  const exec = db.exec.bind(db);
  return vi.spyOn(db, "exec").mockImplementation((sql) => {
    exec(sql);
    if (sql === command) {
      throw error;
    }
  });
}
