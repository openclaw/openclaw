import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionActorAuthority } from "../../config/sessions/session-actor-contract.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import { withIncognitoSessionActor } from "../../config/sessions/session-incognito-binding.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import * as projectClone from "../../projects/project-clone.js";
import { registerClonedProjectRegistry } from "../../projects/project-registry.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  initializeRepository,
  invokeProjectMethod,
  listRegistryRecords,
  resolveRepositoryIdentity,
  withProjectState,
} from "./projects.test-support.js";

beforeEach(() => {
  listRegistryRecords.mockClear();
  resolveRepositoryIdentity.mockClear();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

test.each(["existing", "after-check"])(
  "projects.remove preserves a checkout referenced by an %s memory session in another agent",
  async (timing) => {
    await withProjectState(async (state) => {
      const originUrl = "https://github.com/acme/memory-project.git";
      const fingerprint = sha256HexPrefixCore(originUrl, 16);
      const repo = await initializeRepository(
        path.join(state.stateDir, "projects", fingerprint),
        "memory-project",
        originUrl,
      );
      const project = await registerClonedProjectRegistry({
        path: repo,
        name: "Memory project",
        originUrl,
      });
      const authority: SessionActorAuthority = { assertCurrent() {}, authorize() {} };
      const lifetime = { assertCurrent() {}, assertReadable() {} };
      const mainOwner = memorySessionActorOwners.get({
        agentId: "main",
        path: path.join(state.stateDir, "agents/main/sessions/incognito.sqlite"),
      });
      const otherOwner = memorySessionActorOwners.get({
        agentId: "other",
        path: path.join(state.stateDir, "agents/other/sessions/incognito.sqlite"),
      });
      const sessionKey = "agent:main:dashboard:incognito-project";
      const otherKey = "agent:other:dashboard:incognito-reference";
      const actor = await mainOwner.acquire({ database: mainOwner.identity, sessionKey }, lifetime);
      const other = await otherOwner.acquire(
        { database: otherOwner.identity, sessionKey: otherKey },
        lifetime,
      );
      assert(actor.storage && other.storage);
      await actor.storage.mutate(
        { type: "session.entry.create", input: { entry: { sessionId: "project", updatedAt: 1 } } },
        authority,
      );
      const addReference = () =>
        other.storage!.mutate(
          {
            type: "session.entry.create",
            input: { entry: { sessionId: "reference", updatedAt: 1, spawnedCwd: repo } },
          },
          authority,
        );
      if (timing === "existing") {
        expect(await addReference()).toMatchObject({ kind: "committed" });
      }
      const remove = projectClone.removeClonedProjectCheckout;
      let checks = 0;
      const observer = vi
        .spyOn(projectClone, "removeClonedProjectCheckout")
        .mockImplementation((selected, check, options) =>
          remove(
            selected,
            async () => {
              await check();
              if (++checks === 2 && timing === "after-check") {
                expect(await addReference()).toMatchObject({ kind: "committed" });
              }
            },
            options,
          ),
        );
      try {
        const result = await runWithSessionActorStorage(
          { actor, authority, agentId: mainOwner.agentId, path: mainOwner.path },
          () =>
            invokeProjectMethod(
              "projects.remove",
              { id: project.id, deleteCheckout: true },
              {
                agents: { entries: { main: { workspace: state.workspaceDir } } },
              },
            ),
        );
        expect(result).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", message: expect.stringContaining(otherKey) },
        });
        await expect(fs.stat(repo)).resolves.toBeDefined();
      } finally {
        observer.mockRestore();
        memorySessionActorOwners.closeDatabase(mainOwner);
        memorySessionActorOwners.closeDatabase(otherOwner);
      }
    });
  },
);

test.each(["native", "actor", "actor-changed-after-check"])(
  "projects.remove preserves a checkout referenced by a %s session",
  async (mode) => {
    return withProjectState(async (state) => {
      const originUrl = "https://github.com/acme/session-project.git";
      const fingerprint = sha256HexPrefixCore(originUrl, 16);
      const repo = await initializeRepository(
        path.join(state.stateDir, "projects", fingerprint),
        "session-project",
        originUrl,
      );
      const project = await registerClonedProjectRegistry({
        path: repo,
        name: "Session project",
        originUrl,
      });
      const authority = { assertCurrent() {} };
      const actor =
        mode === "native"
          ? undefined
          : await captureOpenClawAgentDatabaseExecution({
              kind: "ephemeral",
              agentId: "main",
              env: state.env,
              authority,
            });
      const sessionKey = actor
        ? "agent:main:dashboard:incognito-project-session"
        : "agent:main:project-session";
      const entry = {
        sessionId: "project-session",
        updatedAt: 1,
        ...(mode !== "actor-changed-after-check" && { spawnedCwd: repo }),
        ...(actor && { incognito: true as const }),
      };
      if (actor) {
        await actor.sessions.create(authority, { sessionKey, entry });
      } else {
        await upsertSessionEntryCore({ agentId: "main", env: state.env, sessionKey }, entry);
      }
      const cfg = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
      } as OpenClawConfig;

      const remove = projectClone.removeClonedProjectCheckout;
      let checks = 0;
      const observer = vi
        .spyOn(projectClone, "removeClonedProjectCheckout")
        .mockImplementation((selected, check, options) =>
          remove(
            selected,
            async () => {
              await check();
              if (++checks === 2 && mode === "actor-changed-after-check") {
                assert(actor);
                await actor.sessions.create(authority, {
                  sessionKey: `${sessionKey}-new`,
                  entry: {
                    sessionId: "project-new",
                    updatedAt: 2,
                    incognito: true,
                    spawnedCwd: repo,
                  },
                });
              }
            },
            options,
          ),
        );
      try {
        const invoke = () =>
          invokeProjectMethod("projects.remove", { id: project.id, deleteCheckout: true }, cfg);
        expect(
          actor ? await withIncognitoSessionActor(actor, invoke) : await invoke(),
        ).toMatchObject({
          ok: false,
          error: {
            code: mode === "actor-changed-after-check" ? "UNAVAILABLE" : "INVALID_REQUEST",
            message: expect.stringContaining(
              mode === "actor-changed-after-check" ? "snapshot changed" : "project-session",
            ),
          },
        });
        await expect(fs.stat(repo)).resolves.toBeDefined();
      } finally {
        observer.mockRestore();
        await actor?.close();
      }
    });
  },
);

test("projects.list includes retained actor recents and refuses a changed snapshot before disclosure", async () => {
  await withProjectState(async (state) => {
    const profile = ensureProfileForEmail("incognito-projects@example.test");
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    const folder = path.join(state.workspaceDir, "private-project");
    await fs.mkdir(folder, { recursive: true });
    const authority = { assertCurrent() {} };
    const actor = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "main",
      env: state.env,
      authority,
    });
    assert(actor);
    const sessionKey = "agent:main:dashboard:incognito-project-recent";
    try {
      await actor.sessions.create(authority, {
        sessionKey,
        entry: {
          sessionId: "project-recent",
          updatedAt: 1,
          incognito: true,
          spawnedCwd: folder,
          execCwd: folder,
          createdActor: { type: "human", source: "profile", id: profile.id },
        },
      });
      await withIncognitoSessionActor(actor, async () => {
        expect(
          await invokeProjectMethod("projects.list", {}, cfg, ["operator.write"], profile.id),
        ).toMatchObject({
          ok: true,
          payload: { recents: [{ kind: "folder", folder, displayName: "private-project" }] },
        });
        let replacementCommitted = false;
        listRegistryRecords.mockImplementationOnce(async () => {
          await actor.sessions.create(authority, {
            sessionKey: `${sessionKey}-new`,
            entry: { sessionId: "project-next", updatedAt: 2, incognito: true },
          });
          replacementCommitted = true;
          return [];
        });
        const result = await invokeProjectMethod(
          "projects.list",
          { includeObserved: true },
          cfg,
          ["operator.write"],
          profile.id,
        );
        expect(replacementCommitted).toBe(true);
        expect(
          (await actor.sessions.read(authority, { sessionKey: `${sessionKey}-new` })).entry,
        ).toMatchObject({ sessionId: "project-next" });
        expect(result).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE", message: expect.stringContaining("snapshot changed") },
        });
      });
    } finally {
      await actor.close();
    }
  });
});
