import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("resolveSqliteTargetFromSessionStorePath", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it("keeps a multiply registered exact SQLite locator shared", () => {
    const databasePath = path.resolve("tmp", "stores", "existing-shared.sqlite");

    expect(
      resolveSqliteTargetFromSessionStorePath(databasePath, {
        defaultAgentId: "main",
        registeredDatabases: [
          { agentId: "main", path: databasePath },
          { agentId: "ops", path: databasePath },
        ],
      }),
    ).toMatchObject({
      agentId: "main",
      ownerSource: "ambiguous-registry",
      path: databasePath,
      shared: true,
    });
  });

  it("keeps an incognito sentinel owned by its requested agent", () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-incognito-target-") };
    const databasePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "ops", env });

    expect(
      resolveSqliteTargetFromSessionStorePath(databasePath, {
        agentId: "ops",
        defaultAgentId: "main",
        env,
      }),
    ).toEqual({ agentId: "ops", path: databasePath });
  });

  it.runIf(process.platform !== "win32")(
    "does not normalize a missing registered symlink target into ownership",
    () => {
      const dir = tempDirs.make("openclaw-registered-session-symlink-");
      const aliasPath = path.join(dir, "alias.sqlite");
      fs.symlinkSync(`missing${path.sep}ops.sqlite${path.sep}`, aliasPath);

      expect(
        resolveSqliteTargetFromSessionStorePath(path.join(dir, "missing", "ops.json"), {
          agentId: "main",
          defaultAgentId: "main",
          registeredDatabases: [{ agentId: "ops", path: aliasPath }],
        }),
      ).toMatchObject({
        path: path.join(dir, "missing", "ops.sqlite"),
        ownerSource: "configured-default",
        unsuffixedOwnerAgentId: "main",
      });
    },
  );

  it("rejects inconclusive ownership for a json locator and retries after recovery", () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-inconclusive-session-owner-"));
    const occupiedNames = Array.from("bcdefghijklmnopqrstuvwxyz0123456789");
    for (const name of occupiedNames) {
      fs.writeFileSync(path.join(root, name), "preserve");
    }
    const missingDirectory = path.join(root, "a");
    const resolve = () =>
      resolveSqliteTargetFromSessionStorePath(path.join(missingDirectory, "shared.json"), {
        agentId: "main",
        defaultAgentId: "main",
        registeredDatabases: [
          { agentId: "main", path: path.join(missingDirectory, "unrelated.sqlite") },
        ],
      });

    expect(resolve).toThrow("Cannot determine whether database paths alias");
    expect(fs.readdirSync(root).toSorted()).toEqual(occupiedNames.toSorted());
    for (const name of occupiedNames) {
      fs.unlinkSync(path.join(root, name));
    }
    expect(resolve()).toMatchObject({
      agentId: "main",
      ownerSource: "configured-default",
      path: path.join(missingDirectory, "shared.sqlite"),
    });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("does not assign an ambiguously registered unsuffixed target to the default", () => {
    const storePath = path.join("tmp", "stores", "shared.json");
    const unsuffixedPath = path.resolve("tmp", "stores", "shared.sqlite");

    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "main",
        defaultAgentId: "main",
        registeredDatabases: [
          { agentId: "main", path: unsuffixedPath },
          { agentId: "ops", path: unsuffixedPath },
        ],
      }).path,
    ).toBe(path.resolve("tmp", "stores", "shared.main.sqlite"));
  });

  it("searches past every occupied suffix for the first free target", () => {
    const storePath = path.join("tmp", "stores", "shared.json");
    const registeredDatabases = Array.from({ length: 33 }, (_, offset) => {
      const index = offset + 1;
      const fileName = index === 1 ? "shared.worker.sqlite" : `shared.worker.${index}.sqlite`;
      return { agentId: "ops", path: path.resolve("tmp", "stores", fileName) };
    });

    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "worker",
        defaultAgentId: "main",
        registeredDatabases,
      }).path,
    ).toBe(path.resolve("tmp", "stores", "shared.worker.34.sqlite"));
  });

  it("ignores a sparse huge suffix when the conventional suffix is free", () => {
    const storePath = path.join("tmp", "stores", "shared.json");

    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "worker",
        defaultAgentId: "main",
        registeredDatabases: [
          {
            agentId: "ops",
            path: path.resolve("tmp", "stores", "shared.worker.2147483647.sqlite"),
          },
        ],
      }).path,
    ).toBe(path.resolve("tmp", "stores", "shared.worker.sqlite"));
  });

  it("does not treat noncanonical numeric suffix spellings as occupied indices", () => {
    const storePath = path.join("tmp", "stores", "shared.json");

    expect(
      resolveSqliteTargetFromSessionStorePath(storePath, {
        agentId: "worker",
        defaultAgentId: "main",
        registeredDatabases: [
          {
            agentId: "ops",
            path: path.resolve("tmp", "stores", "shared.worker.sqlite"),
          },
          {
            agentId: "ops",
            path: path.resolve("tmp", "stores", "shared.worker.02.sqlite"),
          },
        ],
      }).path,
    ).toBe(path.resolve("tmp", "stores", "shared.worker.2.sqlite"));
  });

  it.runIf(process.platform !== "win32")(
    "does not assign a dangling unsuffixed symlink to the default",
    () => {
      const dir = tempDirs.make("openclaw-session-unsuffixed-symlink-");
      const storePath = path.join(dir, "shared.json");
      fs.symlinkSync(path.join(dir, "missing-target.sqlite"), path.join(dir, "shared.sqlite"));

      expect(
        resolveSqliteTargetFromSessionStorePath(storePath, {
          agentId: "main",
          defaultAgentId: "main",
        }).path,
      ).toBe(path.join(dir, "shared.main.sqlite"));
    },
  );

  it("propagates non-missing target-directory inspection errors", () => {
    const dir = tempDirs.make("openclaw-session-suffix-inspection-");
    const blocker = path.join(dir, "not-a-directory");
    fs.writeFileSync(blocker, "blocked\n");

    expect(() =>
      resolveSqliteTargetFromSessionStorePath(path.join(blocker, "shared.json"), {
        agentId: "worker",
        defaultAgentId: "main",
      }),
    ).toThrow(expect.objectContaining({ code: "ENOTDIR" }));
  });

  it("keeps shared custom sessions.json targets distinct by agent", () => {
    const storePath = path.join("tmp", "stores", "sessions.json");

    expect(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" })).toMatchObject({
      path: path.resolve("tmp", "stores", "openclaw-agent.sqlite"),
    });
    expect(resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "work" })).toMatchObject({
      path: path.resolve("tmp", "stores", "openclaw-agent.work.sqlite"),
    });
  });
});
