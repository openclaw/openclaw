import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
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
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "./session-accessor.js";
import { prepareSqliteTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import * as targetWorker from "./session-transcript-read-worker-runtime.js";

describe("explicit SQLite session target ownership", () => {
  it("keeps scoped rows for multiple agents in one exact SQLite locator", async () => {
    await withTempHome(async (home) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
      const storePath = path.join(home, "shared.sqlite");
      const mainScope = {
        agentId: "main",
        defaultAgentId: "main",
        env,
        sessionKey: "agent:main:main",
        storePath,
      };
      const opsScope = {
        agentId: "ops",
        defaultAgentId: "main",
        env,
        sessionKey: "agent:ops:main",
        storePath,
      };

      const now = Date.now();
      await replaceSessionEntry(mainScope, { sessionId: "main-session", updatedAt: now });
      await replaceSessionEntry(opsScope, { sessionId: "ops-session", updatedAt: now + 1 });

      expect(loadSessionEntry(mainScope)).toMatchObject({ sessionId: "main-session" });
      expect(loadSessionEntry(opsScope)).toMatchObject({ sessionId: "ops-session" });
    });
  });

  it("honors cold durable ownership when registration is ambiguous", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const databasePath = path.join(home, "shared.sqlite");
      openOpenClawAgentDatabase({ agentId: "ops", env, path: databasePath });
      await closeOpenClawAgentDatabaseByPathAsync(databasePath);
      registerOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });

      expect(resolveSqliteTargetFromSessionStorePath(databasePath, { env })).toMatchObject({
        agentId: "ops",
        ownerSource: "database-path",
        path: databasePath,
      });
    });
  });

  it.each([
    { locator: "shared.json", database: "shared.sqlite", ownerSource: "database-registry" },
    { locator: "shared.json", database: "shared.main.sqlite", ownerSource: "registered-suffixed" },
  ])(
    "rejects a mismatched physical owner for $locator in $database",
    async ({ locator, database, ownerSource }) => {
      await withTempHome(async (home) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
        const storePath = path.join(home, locator);
        const databasePath = path.join(home, database);
        openOpenClawAgentDatabase({ agentId: "ops", env, path: databasePath });
        await closeOpenClawAgentDatabaseByPathAsync(databasePath);
        unregisterOpenClawAgentDatabase({ agentId: "ops", env, path: databasePath });
        registerOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });

        expect(resolveSqliteTargetFromSessionStorePath(storePath, { env })).toMatchObject({
          agentId: "main",
          ownerSource,
          path: databasePath,
        });
        expect(() =>
          loadSessionEntryReadOnly({
            agentId: "main",
            env,
            storePath,
            sessionKey: "agent:main:main",
          }),
        ).toThrow("belongs to agent ops; requested agent main");
      });
    },
  );
});

it("prepares an exact SQLite locator without host SQL or logical-owner substitution", async () => {
  await withOpenClawTestState({ label: "session-physical-target" }, async (state) => {
    const databasePath = path.join(state.root, "shared.sqlite");
    const database = openOpenClawAgentDatabase({
      agentId: "ops",
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
        agentId: "worker",
        sessionKey: "agent:worker:main",
        sessionId: "physical-target",
        storePath: databasePath,
      });
      expect(resolved).toMatchObject({ agentId: "worker", path: databasePath });
      expect(resolved.databaseAgentId ?? resolved.agentId).toBe("ops");
      expect(probes.flatMap((probe) => probe.mock.calls)).toEqual([]);
    } finally {
      probes.forEach((probe) => probe.mockRestore());
    }
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
