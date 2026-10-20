import { describe, expect, it } from "vitest";
import { ensureSessionGroupCatalog } from "../../gateway/session-group-catalog.js";
import { readSessionGroupCatalogSnapshot } from "../../gateway/session-group-catalog.kernel.js";
import { putSessionGroups, updateSessionGroupDefaults } from "../../gateway/session-groups.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection).each(["sqlite", "postgres"] as const)(
  "%s session group catalog",
  (engine) => {
    useMixedAgentPair(engine, engine);

    it("reads empty catalogs, sidebar order and committed group defaults together", async () => {
      const env = { ...process.env };
      await ensureSessionGroupCatalog(env);
      const read = () =>
        withEngineStoreAdmission(() => {
          const { db } = openOpenClawStateDatabase({ env });
          expect(isPostgresSqlConnection(db)).toBe(engine === "postgres");
          return readSessionGroupCatalogSnapshot(db);
        });
      expect(read()).toEqual({ groups: [], defaults: [], sectionOrder: [] });
      await putSessionGroups({ cfg: {}, names: [], sectionOrder: ["work"], env });
      expect(read()).toEqual({ groups: [], defaults: [], sectionOrder: ["work"] });
      await putSessionGroups({ cfg: {}, names: ["Zulu", "Alpha"], env });
      await updateSessionGroupDefaults("Alpha", { cwd: "/synthetic/repo", worktree: true }, env);
      expect(read()).toEqual({
        groups: [
          { name: "Zulu", position: 0 },
          { name: "Alpha", position: 1 },
        ],
        defaults: [{ name: "Zulu" }, { name: "Alpha", cwd: "/synthetic/repo", worktree: true }],
        sectionOrder: ["work"],
      });
    });
  },
);
