import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256HexPrefixCore } from "../../infra/crypto-digest.js";
import * as projectClone from "../../projects/project-clone.js";
import { registerClonedProjectRegistry } from "../../projects/project-registry.test-support.js";
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
  memorySessionActorOwners.reset();
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
      const sessionKey = "agent:main:dashboard:incognito-project";
      const otherKey = "agent:other:dashboard:incognito-reference";
      await upsertSessionEntryCore(
        { env: state.env, sessionKey },
        {
          sessionId: "project",
          updatedAt: 1,
          incognito: true,
        },
      );
      const addReference = () =>
        upsertSessionEntryCore(
          { agentId: "other", env: state.env, sessionKey: otherKey },
          { sessionId: "reference", updatedAt: 1, incognito: true, spawnedCwd: repo },
        );
      if (timing === "existing") {
        await addReference();
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
                await addReference();
              }
            },
            options,
          ),
        );
      try {
        const result = await invokeProjectMethod(
          "projects.remove",
          { id: project.id, deleteCheckout: true },
          { agents: { entries: { main: { workspace: state.workspaceDir } } } },
        );
        expect(result).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", message: expect.stringContaining(otherKey) },
        });
        await expect(fs.stat(repo)).resolves.toBeDefined();
      } finally {
        observer.mockRestore();
      }
    });
  },
);

test.each(["durable", "memory", "memory-changed-after-check"])(
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
      const sessionKey =
        mode === "durable"
          ? "agent:main:project-session"
          : "agent:main:dashboard:incognito-project-session";
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        {
          sessionId: "project-session",
          updatedAt: 1,
          ...(mode !== "memory-changed-after-check" && { spawnedCwd: repo }),
          ...(mode !== "durable" && { incognito: true as const }),
        },
      );
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
              if (++checks === 2 && mode === "memory-changed-after-check") {
                await upsertSessionEntryCore(
                  { agentId: "main", env: state.env, sessionKey: `${sessionKey}-new` },
                  { sessionId: "project-new", updatedAt: 2, incognito: true, spawnedCwd: repo },
                );
              }
            },
            options,
          ),
        );
      try {
        const invoke = () =>
          invokeProjectMethod("projects.remove", { id: project.id, deleteCheckout: true }, cfg);
        expect(await invoke()).toMatchObject({
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: expect.stringContaining(
              mode === "memory-changed-after-check" ? `${sessionKey}-new` : sessionKey,
            ),
          },
        });
        await expect(fs.stat(repo)).resolves.toBeDefined();
      } finally {
        observer.mockRestore();
      }
    });
  },
);

test("projects.list includes recents from an unbound memory session", async () => {
  await withProjectState(async (state) => {
    const profile = ensureProfileForEmail("incognito-projects@example.test");
    const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    const folder = path.join(state.workspaceDir, "private-project");
    await fs.mkdir(folder, { recursive: true });
    const sessionKey = "agent:main:dashboard:incognito-project-recent";
    await upsertSessionEntryCore(
      { env: state.env, sessionKey },
      {
        sessionId: "project-recent",
        updatedAt: 1,
        incognito: true,
        spawnedCwd: folder,
        execCwd: folder,
        createdActor: { type: "human", source: "profile", id: profile.id },
      },
    );
    expect(
      await invokeProjectMethod("projects.list", {}, cfg, ["operator.write"], profile.id),
    ).toMatchObject({
      ok: true,
      payload: { recents: [{ kind: "folder", folder, displayName: "private-project" }] },
    });
  });
});
