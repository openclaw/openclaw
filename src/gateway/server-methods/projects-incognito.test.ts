import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import * as projectClone from "../../projects/project-clone.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { clonedProject } from "./projects-shard.test-support.js";
import {
  invokeProjectMethod,
  listRegistryRecords,
  resolveRepositoryIdentity,
  withProjectState,
} from "./projects.test-support.js";

async function expectCheckoutInUse(
  repo: string,
  id: string,
  cfg: Parameters<typeof invokeProjectMethod>[2],
  reference: string,
) {
  expect(
    await invokeProjectMethod("projects.remove", { id, deleteCheckout: true }, cfg),
  ).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: expect.stringContaining(reference) },
  });
  await expect(fs.stat(repo)).resolves.toBeDefined();
}
function observeSecondRemovalCheck(afterCheck: () => Promise<unknown>) {
  const remove = projectClone.removeClonedProjectCheckout;
  let checks = 0;
  return vi
    .spyOn(projectClone, "removeClonedProjectCheckout")
    .mockImplementation((selected, check, options) =>
      remove(
        selected,
        async () => {
          await check();
          if (++checks === 2) {
            await afterCheck();
          }
        },
        options,
      ),
    );
}

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
      const { repo, project } = await clonedProject(state, "memory-project", "Memory project");
      const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:dashboard:incognito-project";
      const otherKey = "agent:other:dashboard:incognito-reference";
      await upsertSessionEntryCore(
        { env: state.env, sessionKey },
        { sessionId: "project", updatedAt: 1, incognito: true },
      );
      const addReference = () =>
        upsertSessionEntryCore(
          { agentId: "other", env: state.env, sessionKey: otherKey },
          { sessionId: "reference", updatedAt: 1, incognito: true, spawnedCwd: repo },
        );
      if (timing === "existing") {
        await addReference();
      }
      using _ = observeSecondRemovalCheck(async () => {
        if (timing === "after-check") {
          await addReference();
        }
      });
      await expectCheckoutInUse(repo, project.id, cfg, otherKey);
    });
  },
);

test.each(["durable", "memory", "memory-changed-after-check"])(
  "projects.remove preserves a checkout referenced by a %s session",
  async (mode) => {
    return withProjectState(async (state) => {
      const { repo, project } = await clonedProject(state, "session-project", "Session project");
      const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      setRuntimeConfigSnapshot(cfg);
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
      using _ = observeSecondRemovalCheck(async () => {
        if (mode === "memory-changed-after-check") {
          await upsertSessionEntryCore(
            { agentId: "main", env: state.env, sessionKey: `${sessionKey}-new` },
            { sessionId: "project-new", updatedAt: 2, incognito: true, spawnedCwd: repo },
          );
        }
      });
      await expectCheckoutInUse(
        repo,
        project.id,
        cfg,
        mode === "memory-changed-after-check" ? `${sessionKey}-new` : sessionKey,
      );
    });
  },
);

test.each(["unchanged", "unrelated visibility", "contributing visibility"])(
  "projects.list checks contributing unbound memory recents after %s",
  async (change) => {
    await withProjectState(async (state) => {
      const profile = ensureProfileForEmail("incognito-projects@example.test");
      const cfg = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
      setRuntimeConfigSnapshot(cfg);
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
      const unrelatedKey = `${sessionKey}-unrelated`;
      if (change === "unrelated visibility") {
        await upsertSessionEntryCore(
          { env: state.env, sessionKey: unrelatedKey },
          { sessionId: "unrelated", updatedAt: 1, incognito: true },
        );
      }
      listRegistryRecords.mockImplementationOnce(async () => {
        if (change !== "unchanged") {
          await patchSessionEntryCore(
            {
              env: state.env,
              sessionKey: change === "unrelated visibility" ? unrelatedKey : sessionKey,
            },
            () => ({ visibility: "draft" }),
          );
        }
        return [];
      });
      const result = await invokeProjectMethod(
        "projects.list",
        { includeObserved: true },
        cfg,
        ["operator.write"],
        profile.id,
      );
      if (change === "contributing visibility") {
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: expect.stringContaining("Project access changed"),
          },
        });
        expect(result?.payload).toBeUndefined();
        return;
      }
      expect(result).toMatchObject({
        ok: true,
        payload: { recents: [{ kind: "folder", folder, displayName: "private-project" }] },
      });
    });
  },
);
