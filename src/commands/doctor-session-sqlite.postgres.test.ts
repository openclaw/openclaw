import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { installDatabaseProcessRole } from "../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../infra/database-engine/mixed-agent.conformance.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

describe.skipIf(!mixedAgentConnection)("Doctor legacy session import on PostgreSQL", () => {
  installDatabaseProcessRole("cli-oneshot");
  const fixture = useMixedAgentPair("postgres", "postgres");

  it("validates the imported session and archives its legacy index", async () => {
    const store = path.join(fixture.root, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(
      store,
      JSON.stringify({
        "agent:main:main": { sessionId: "canonical-import", updatedAt: Date.now() },
      }),
    );

    const report = await runDoctorSessionSqlite({ mode: "import", store });

    expect(report.totals.importedEntries).toBe(1);
    expect(report.targets.flatMap(({ issues }) => issues)).not.toContainEqual(
      expect.objectContaining({ code: "sqlite_entry_missing" }),
    );
    expect(fs.existsSync(store)).toBe(false);
  });
});
