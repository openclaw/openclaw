import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import * as databaseRegistry from "../../state/openclaw-agent-db-registry.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { dedupeSessionStoreTargetsBySqliteTarget } from "./targets.js";

describe("session store target dedupe", () => {
  it("reads one ownership snapshot for multiple shared targets", async () => {
    await withTempHome(async (home) => {
      const targets = Array.from({ length: 3 }, (_, index) => ({
        agentId: "main",
        storePath: path.join(home, `shared-${index}.sqlite`),
      }));
      using readRegistry = vi.spyOn(databaseRegistry, "listOpenClawRegisteredAgentDatabases");
      expect(dedupeSessionStoreTargetsBySqliteTarget(targets, { defaultAgentId: "main" })).toEqual(
        targets,
      );
      expect(readRegistry).toHaveBeenCalledTimes(1);
    });
  });

  it.runIf(process.platform !== "win32")(
    "leaves a sole canonical target's inspection to its consumer",
    async () => {
      await withTempHome(async (home) => {
        const stateDir = path.join(home, ".openclaw");
        const agentsDir = path.join(stateDir, "agents");
        await fs.mkdir(agentsDir, { recursive: true });
        await fs.symlink("one", path.join(agentsDir, "one"), "dir");
        const target = {
          agentId: "one",
          storePath: path.join(agentsDir, "one", "sessions", "sessions.json"),
        };

        expect(
          dedupeSessionStoreTargetsBySqliteTarget([target], {
            defaultAgentId: "one",
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
            registeredDatabases: [],
          }),
        ).toEqual([target]);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "refreshes aliased SQLite locators between dedupe calls",
    async () => {
      await withTempHome(async (home) => {
        const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, ".openclaw") };
        const realDir = path.join(home, "real-stores");
        const aliasDir = path.join(home, "alias-stores");
        await fs.mkdir(realDir, { recursive: true });
        await fs.symlink(realDir, aliasDir, "dir");
        const targets = [
          { agentId: "main", storePath: path.join(realDir, "shared.sqlite") },
          { agentId: "ops", storePath: path.join(aliasDir, "shared.sqlite") },
        ];
        const diagnostics: string[] = [];
        const resolverOptions = {
          agentId: "ops",
          defaultAgentId: "main",
          registeredDatabases: [{ agentId: "ops", path: path.join(realDir, "shared.sqlite") }],
        };
        const resolve = (name: string) =>
          resolveSqliteTargetFromSessionStorePath(path.join(aliasDir, name), resolverOptions);
        const assertOwner = (agentId: string, ownerSource: string, customFile: string) => {
          expect(resolve("shared.sqlite")).toMatchObject({
            agentId,
            ownerSource,
            path: path.join(aliasDir, "shared.sqlite"),
            shared: true,
          });
          expect(resolve("shared.json")).toMatchObject({
            path: path.join(aliasDir, customFile),
            unsuffixedOwnerAgentId: agentId,
          });
        };
        assertOwner("ops", "database-registry", "shared.sqlite");

        expect(
          dedupeSessionStoreTargetsBySqliteTarget(targets, {
            defaultAgentId: "main",
            env,
            onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
          }),
        ).toEqual([targets[0]]);
        expect(diagnostics).toContainEqual(expect.stringContaining('ignored owner(s): "ops"'));

        const otherDir = path.join(home, "other-stores");
        await fs.mkdir(otherDir);
        await fs.unlink(aliasDir);
        await fs.symlink(otherDir, aliasDir, "dir");
        assertOwner("main", "configured-default", "shared.ops.sqlite");
        expect(
          dedupeSessionStoreTargetsBySqliteTarget(targets, { defaultAgentId: "main", env }),
        ).toHaveLength(2);
      });
    },
  );

  it("prepares each SQLite identity once during one dedupe pass", async () => {
    await withTempHome(async (home) => {
      const realHome = realpathSync(home);
      const targets = await Promise.all(
        Array.from({ length: 29 }, async (_, index) => {
          const agentId = `agent-${index}`;
          const dir = path.join(realHome, ".openclaw", "agents", agentId);
          await fs.mkdir(path.join(dir, "agent"), { recursive: true });
          return { agentId, storePath: path.join(dir, "sessions", "sessions.json") };
        }),
      );
      const databasePaths = new Set(
        targets.map(({ storePath }) =>
          path.join(path.dirname(path.dirname(storePath)), "agent", "openclaw-agent.sqlite"),
        ),
      );
      using realpathNative = vi.spyOn(realpathSync, "native");
      expect(
        dedupeSessionStoreTargetsBySqliteTarget([...targets, ...targets], {
          defaultAgentId: targets[0]!.agentId,
        }),
      ).toEqual(targets);
      // Parent lookup can use fs-safe's native backend; every identity starts here.
      const preparedPaths = realpathNative.mock.calls.flatMap(([pathname]) =>
        typeof pathname === "string" && databasePaths.has(pathname) ? [pathname] : [],
      );
      expect(preparedPaths).toHaveLength(targets.length);
      expect(new Set(preparedPaths).size).toBe(preparedPaths.length);
    });
  });
});
