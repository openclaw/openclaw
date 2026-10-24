import fs from "node:fs";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getForeignLiveSessionPendingInputEntries } from "./session-accessor.pending-inputs.js";
import { prepareSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";

it.each([
  { locator: "shared.sqlite", file: "shared.sqlite", logicalAgent: "worker", registry: true },
  { locator: "shared.json", file: "shared.sqlite", logicalAgent: "ops", registry: true },
  { locator: "shared.json", file: "shared.ops.sqlite", logicalAgent: "ops", registry: true },
  { locator: "external.sqlite", file: "external.sqlite", logicalAgent: "worker", registry: false },
])("prepares $locator at $file without host SQL or logical-owner substitution", async (fixture) => {
  await withOpenClawTestState({ label: "session-physical-target" }, async (state) => {
    const databasePath = path.join(state.root, fixture.file);
    const database = openOpenClawAgentDatabase({
      agentId: "ops",
      path: databasePath,
    });
    const statement = Object.getPrototypeOf(database.db.prepare("SELECT 1")) as StatementSync;
    await closeOpenClawAgentDatabaseByPathAsync(databasePath);
    const stateDir = path.join(state.root, "empty-state");
    const probes = [
      vi.spyOn(statement, "all"),
      vi.spyOn(statement, "get"),
      vi.spyOn(statement, "run"),
      vi.spyOn(statement, "iterate"),
      vi.spyOn(Object.getPrototypeOf(database.db), "exec"),
      vi.spyOn(Object.getPrototypeOf(database.db), "prepare"),
    ];
    try {
      const resolved = await prepareSqliteTranscriptReadScope({
        agentId: fixture.logicalAgent,
        ...(fixture.registry ? {} : { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }),
        sessionKey: `agent:${fixture.logicalAgent}:main`,
        sessionId: "physical-target",
        storePath: path.join(state.root, fixture.locator),
      });
      expect(resolved).toMatchObject({ agentId: fixture.logicalAgent, path: databasePath });
      expect(resolved.databaseAgentId ?? resolved.agentId).toBe("ops");
      expect(
        await getForeignLiveSessionPendingInputEntries({
          agentId: fixture.logicalAgent,
          ...(fixture.registry ? {} : { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }),
          sessionKey: `agent:${fixture.logicalAgent}:main`,
          sessionId: "physical-target",
          storePath: path.join(state.root, fixture.locator),
        }),
      ).toEqual(new Map());
      expect(probes.flatMap((probe) => probe.mock.calls)).toEqual([]);
      if (!fixture.registry) {
        expect(resolved.databaseAgentId).toBe("ops");
        expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
      }
    } finally {
      probes.forEach((probe) => probe.mockRestore());
    }
  });
});
