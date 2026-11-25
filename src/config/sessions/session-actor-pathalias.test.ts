import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import type { SessionActorAuthority } from "./session-actor-contract.js";
import { captureDurableSessionActor } from "./session-actor-durable.js";
import {
  assertSessionActorPathAliasReuse,
  createAliasedSessionStateRoot,
} from "./session-actor-pathalias.test-support.js";

it("reuses the actor through admitted SQLite path aliases without crossing database identities", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: false },
    async (state) => {
      const alias = await createAliasedSessionStateRoot(state.root, state.stateDir);
      const aliases = {
        OPENCLAW_STATE_DIR: alias,
        OPENCLAW_CONFIG_PATH: path.join(alias, "openclaw.json"),
      };
      Object.assign(state.envVars, aliases);
      Object.assign(state.env, aliases);
      state.applyEnv();
      await captureRuntimeConfigAsyncReader()();
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      await assertSessionActorPathAliasReuse(
        database,
        openOpenClawAgentDatabase({
          agentId: "main",
          path: path.join(path.dirname(database.path), "other.sqlite"),
        }),
        state.env,
      );
    },
  );
});

it("refuses durable actor capture when its lifetime retires during preparation", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", prepareProfileCatalog: false },
    async (state) => {
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const identity = readOpenClawAgentDatabaseIdentity(database);
      let active = true;
      const capture = captureDurableSessionActor({
        database: { agentId: "main", path: database.path, env: state.env },
        target: {
          sessionKey: "agent:main:retired-capture",
          database: {
            kind: "file",
            physicalIdentity: identity.identity,
            birthtime: identity.birthtime,
            nativeLocation: identity.canonicalPath,
          },
        },
        lifetime: {
          assertCurrent() {
            if (!active) {
              throw new Error("Actor lifetime retired");
            }
          },
          assertReadable() {},
        },
      });
      active = false;
      try {
        await expect(capture).rejects.toThrow("Actor lifetime retired");
      } finally {
        await capture.then(
          (actor) => actor.release(),
          () => undefined,
        );
      }
    },
  );
});

it.each(["readCustody", "workspaceEvidence"] as const)(
  "refuses durable actor work after its authority %s target changes",
  async (kind) => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: false },
      async (state) => {
        const database = openOpenClawAgentDatabase({ agentId: "main" });
        const identity = readOpenClawAgentDatabaseIdentity(database);
        const sessionKey = "agent:main:actor-source";
        const initialEntry = await upsertSessionEntryCore(
          { agentId: "main", storePath: database.path, sessionKey, env: state.env },
          { sessionId: "actor-source", updatedAt: 1 },
        );
        const alias = path.join(state.root, "source-alias");
        const original =
          kind === "readCustody" ? identity.canonicalPath : path.join(state.root, "workspace");
        const replacement = path.join(state.root, "replacement");
        if (kind === "workspaceEvidence") {
          await fs.mkdir(original);
          await fs.mkdir(replacement);
        } else {
          await fs.writeFile(replacement, "synthetic replacement");
        }
        const aliasType =
          kind === "readCustody" ? "file" : process.platform === "win32" ? "junction" : "dir";
        await fs.symlink(original, alias, aliasType);
        const authority: SessionActorAuthority = {
          assertCurrent() {},
          authorize() {},
          ...(kind === "readCustody"
            ? {
                readCustody: [
                  { sourcePath: alias, candidates: [{ path: alias, physicalPath: original }] },
                ],
              }
            : {
                workspaceEvidence: [
                  {
                    workspaceDir: alias,
                    canonical: await fs.realpath(alias),
                    root: (
                      await Promise.all([
                        fs.lstat(alias, { bigint: true }),
                        fs.stat(alias, { bigint: true }),
                      ])
                    ).map((stat) => ({
                      dev: stat.dev,
                      ino: stat.ino,
                      mode: stat.mode,
                      isDirectory: stat.isDirectory(),
                    })),
                  },
                ],
              }),
        };
        const actor = await captureDurableSessionActor({
          database: { agentId: "main", path: identity.canonicalPath, env: state.env },
          target: {
            sessionKey,
            database: {
              kind: "file",
              physicalIdentity: identity.identity,
              birthtime: identity.birthtime,
              nativeLocation: identity.canonicalPath,
            },
          },
          lifetime: { assertCurrent() {}, assertReadable() {} },
        });
        try {
          await fs.unlink(alias);
          await fs.symlink(replacement, alias, aliasType);
          await expect(actor.read(authority)).rejects.toThrow(/custody|workspace/i);
          const outcome = await actor.patch(
            {
              commandId: "refused-source",
              phaseId: "turn",
              reducers: [{ kind: "activity", updatedAt: 999 }],
            },
            authority,
          );
          expect(outcome).toMatchObject({
            kind: "rolled-back",
            error: { message: expect.stringMatching(/custody|workspace/i) },
          });
          expect((await actor.read({ assertCurrent() {}, authorize() {} })).entry?.updatedAt).toBe(
            initialEntry?.updatedAt,
          );
        } finally {
          await actor.release();
        }
      },
    );
  },
);
