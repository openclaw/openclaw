import fs from "node:fs";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { AgentDatabaseRegistryChangedError } from "../../state/openclaw-agent-db-registry-listing.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db-registry.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import * as targetWorker from "./session-transcript-read-worker-runtime.js";

it.each([
  { locator: "shared.sqlite", file: "shared.sqlite", logicalAgent: "worker", physicalAgent: "ops" },
  { locator: "shared.json", file: "shared.sqlite", logicalAgent: "ops", physicalAgent: "ops" },
  { locator: "shared.json", file: "shared.ops.sqlite", logicalAgent: "ops", physicalAgent: "ops" },
])("prepares $locator at $file without host SQL or logical-owner substitution", async (fixture) => {
  await withOpenClawTestState({ label: "session-physical-target" }, async (state) => {
    const databasePath = path.join(state.root, fixture.file);
    const database = openOpenClawAgentDatabase({
      agentId: fixture.physicalAgent,
      path: databasePath,
    });
    const statement = Object.getPrototypeOf(database.db.prepare("SELECT 1")) as StatementSync;
    await closeOpenClawAgentDatabaseByPathAsync(databasePath);
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
        sessionKey: `agent:${fixture.logicalAgent}:main`,
        sessionId: "physical-target",
        storePath: path.join(state.root, fixture.locator),
      });
      expect(resolved).toMatchObject({ agentId: fixture.logicalAgent, path: databasePath });
      expect(resolved.databaseAgentId ?? resolved.agentId).toBe(fixture.physicalAgent);
      expect(probes.flatMap((probe) => probe.mock.calls)).toEqual([]);
    } finally {
      probes.forEach((probe) => probe.mockRestore());
    }
  });
});

it("discovers a durable exact-store owner without creating an absent registry", async () => {
  await withOpenClawTestState({ label: "session-target-without-registry" }, async (state) => {
    const databasePath = path.join(state.root, "external.sqlite");
    openOpenClawAgentDatabase({ agentId: "ops", path: databasePath });
    await closeOpenClawAgentDatabaseByPathAsync(databasePath);
    const stateDir = path.join(state.root, "empty-state");
    const resolved = await prepareSqliteTranscriptReadScope({
      agentId: "worker",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionKey: "agent:worker:main",
      sessionId: "unregistered",
      storePath: databasePath,
    });
    expect(resolved).toMatchObject({
      agentId: "worker",
      databaseAgentId: "ops",
      path: databasePath,
    });
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
  });
});

it("observes registration changes across repeated preparations on the same worker", async () => {
  await withOpenClawTestState({ label: "session-target-registry-refresh" }, async (state) => {
    const databasePath = path.join(state.root, "shared.sqlite");
    openOpenClawAgentDatabase({ agentId: "ops", path: databasePath });
    await closeOpenClawAgentDatabaseByPathAsync(databasePath);
    const target = {
      agentId: "worker",
      sessionKey: "agent:worker:main",
      sessionId: "registry-refresh",
      storePath: databasePath,
    };
    expect((await prepareSqliteTranscriptReadScope(target)).databaseAgentId).toBe("ops");
    unregisterOpenClawAgentDatabase({ agentId: "ops", path: databasePath });
    registerOpenClawAgentDatabase({ agentId: "main", path: databasePath });
    expect((await prepareSqliteTranscriptReadScope(target)).databaseAgentId).toBe("main");
  });
});

it.each(["registration", "repeated registration", "source retirement", "read failure"] as const)(
  "preserves target discovery after %s before a worker reply",
  async (change) => {
    await withOpenClawTestState({ label: "session-target-registry-in-flight" }, async (state) => {
      const databasePath = path.join(state.root, "shared.sqlite");
      openOpenClawAgentDatabase({ agentId: "ops", path: databasePath });
      await closeOpenClawAgentDatabaseByPathAsync(databasePath);
      const held = createDeferred();
      const release = createDeferred();
      const readError = new Error("Synthetic target read failed");
      const resolve = targetWorker.resolveSessionSqliteTargetInWorker;
      let firstRead = true;
      const observation = vi
        .spyOn(targetWorker, "resolveSessionSqliteTargetInWorker")
        .mockImplementation(async (...args) => {
          const result = await resolve(...args);
          if (firstRead) {
            firstRead = false;
            held.resolve();
            await release.promise;
          } else if (change === "repeated registration") {
            unregisterOpenClawAgentDatabase({ agentId: "main", path: databasePath });
            registerOpenClawAgentDatabase({ agentId: "main", path: databasePath });
          }
          if (change === "read failure") {
            throw readError;
          }
          return result;
        });
      const pending = prepareSqliteTranscriptReadScope({
        agentId: "worker",
        sessionKey: "agent:worker:main",
        sessionId: "registry-in-flight",
        storePath: databasePath,
      });
      try {
        await Promise.race([
          held.promise,
          pending.then(() => {
            throw new Error("Target discovery completed before the held worker reply");
          }),
        ]);
        if (change === "source retirement") {
          const shared = openOpenClawStateDatabase({ env: state.env });
          await closeOpenClawStateDatabaseByPathAsync(shared.path);
          openOpenClawStateDatabase({ env: state.env });
        } else {
          unregisterOpenClawAgentDatabase({ agentId: "ops", path: databasePath });
          registerOpenClawAgentDatabase({ agentId: "main", path: databasePath });
        }
        release.resolve();
        if (change === "source retirement") {
          await expect(pending).rejects.toMatchObject({
            code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
          });
        } else if (change === "read failure") {
          await expect(pending).rejects.toBe(readError);
        } else if (change === "repeated registration") {
          await expect(pending).rejects.toBeInstanceOf(AgentDatabaseRegistryChangedError);
        } else {
          expect((await pending).databaseAgentId).toBe("main");
        }
      } finally {
        release.resolve();
        await pending.catch(() => undefined);
        observation.mockRestore();
      }
    });
  },
);
