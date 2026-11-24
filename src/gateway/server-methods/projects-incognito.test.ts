import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import * as projectClone from "../../projects/project-clone.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  clonedProject,
  expectCheckoutInUse,
  projectConfig,
} from "./projects-shard.test-support.js";
import {
  invokeProjectMethod,
  listRegistryRecords,
  resolveRepositoryIdentity,
  withProjectState,
} from "./projects.test-support.js";

function putSession(
  state: Parameters<Parameters<typeof withProjectState>[0]>[0],
  sessionKey: string,
  fields: Partial<SessionEntry> = {},
  agentId?: string,
) {
  return upsertSessionEntryCore(
    { env: state.env, sessionKey, agentId },
    { sessionId: sessionKey, updatedAt: 1, incognito: true, ...fields },
  );
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

test.each(["durable", "memory", "memory-after-check", "other-existing", "other-after-check"])(
  "projects.remove preserves a checkout referenced by a %s session",
  async (mode) => {
    return withProjectState(async (state) => {
      const { repo, project } = await clonedProject(state, "session-project", "Session project");
      const cfg = projectConfig(state.workspaceDir);
      setRuntimeConfigSnapshot(cfg);
      const otherAgent = mode.startsWith("other-");
      const afterCheck = mode.endsWith("after-check");
      const sessionKey =
        mode === "durable"
          ? "agent:main:project-session"
          : "agent:main:dashboard:incognito-project-session";
      const referenceKey = otherAgent
        ? "agent:other:dashboard:incognito-reference"
        : afterCheck
          ? `${sessionKey}-new`
          : sessionKey;
      await putSession(
        state,
        sessionKey,
        {
          ...(!otherAgent && !afterCheck && { spawnedCwd: repo }),
          incognito: mode === "durable" ? undefined : true,
        },
        "main",
      );
      const addReference = () =>
        putSession(
          state,
          referenceKey,
          { spawnedCwd: repo, updatedAt: 2 },
          otherAgent ? "other" : "main",
        );
      if (otherAgent && !afterCheck) {
        await addReference();
      }
      using _ = observeSecondRemovalCheck(async () => {
        if (afterCheck) {
          await addReference();
        }
      });
      await expectCheckoutInUse(repo, project.id, cfg, referenceKey);
    });
  },
);

test.each(["unchanged", "unrelated visibility", "contributing visibility"])(
  "projects.list checks contributing unbound memory recents after %s",
  async (change) => {
    await withProjectState(async (state) => {
      const profile = ensureProfileForEmail("incognito-projects@example.test");
      const cfg = projectConfig(state.workspaceDir);
      setRuntimeConfigSnapshot(cfg);
      const folder = path.join(state.workspaceDir, "private-project");
      await fs.mkdir(folder, { recursive: true });
      const sessionKey = "agent:main:dashboard:incognito-project-recent";
      await putSession(state, sessionKey, {
        spawnedCwd: folder,
        execCwd: folder,
        createdActor: { type: "human", source: "profile", id: profile.id },
      });
      const unrelatedKey = `${sessionKey}-unrelated`;
      if (change === "unrelated visibility") {
        await putSession(state, unrelatedKey);
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
      // A contributing change restarts the read against current memory facts.
      expect(listRegistryRecords).toHaveBeenCalledTimes(
        change === "contributing visibility" ? 2 : 1,
      );
      expect(result).toMatchObject({
        ok: true,
        payload: { recents: [{ kind: "folder", folder, displayName: "private-project" }] },
      });
    });
  },
);
