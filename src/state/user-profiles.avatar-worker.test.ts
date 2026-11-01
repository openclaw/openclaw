import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { onUserProfilesChanged } from "./user-profile-events.js";
import { getUserProfileDisplay, readResidentUserProfileIdentity } from "./user-profile-list.js";
import { linkEmail } from "./user-profile-writes.worker.js";
import { getProfileAvatar } from "./user-profiles-avatar.test-support.js";
import {
  avatarPng,
  avatarResponse,
  useProfileState,
} from "./user-profiles-fixture.test-support.js";
import { adoptTailscaleProfileAvatar, ensureProfileForEmail } from "./user-profiles.js";

const delivery = vi.hoisted(() => ({ fail: false }));
vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: vi
      .fn(actual.runOpenClawStateWorkerOperation)
      .mockImplementation((context, operation, options) =>
        actual.runOpenClawStateWorkerOperation(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                const result = await scope.execute(command, executeOptions);
                if (delivery.fail && command.type === "userProfiles.avatar.adopt") {
                  throw new Error("synthetic result delivery failure");
                }
                return result;
              },
            }),
          options,
        ),
      ),
  };
});

let stop = () => {};
const catalog = useProfileState(undefined, () => {
  delivery.fail = false;
  stop();
  stop = () => {};
});
const bytes = avatarPng();
const adopt = (id: string) => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => avatarResponse(bytes));
  return adoptTailscaleProfileAvatar(id, "https://avatars.example.test/p");
};

it("publishes the known avatar commit even when ordinary result delivery fails", async () => {
  const profile = ensureProfileForEmail("receipt@example.test");
  await catalog.hydrate();
  delivery.fail = true;
  await expect(adopt(profile.id)).rejects.toThrow("synthetic result delivery failure");
  expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(true);
  expect(getProfileAvatar(profile.id)?.bytes).toEqual(bytes);
});

it("adopts an avatar off-thread and publishes its catalog before identity observers", async () => {
  const profile = ensureProfileForEmail("portrait@example.test");
  const alias = ensureProfileForEmail("alias@example.test");
  linkEmail("alias@example.test", profile.id);
  await catalog.hydrate();
  const seen: unknown[] = [];
  stop = onUserProfilesChanged(() => {
    seen.push({
      display: getUserProfileDisplay(alias.id),
      identity: readResidentUserProfileIdentity(alias.id),
    });
  });
  requireNodeSqlite();
  const sql = observeMainThreadSql();
  expect(await adopt(alias.id)).toMatchObject({ id: profile.id, avatarMime: "image/png" });
  expect(seen).toEqual([
    {
      display: expect.objectContaining({ id: profile.id, hasAvatar: true }),
      identity: {
        profileId: profile.id,
        role: null,
        githubLogin: null,
        aliases: new Set([profile.id, alias.id]),
      },
    },
  ]);
  sql.expectIdle();
  sql.restore();
  expect(getProfileAvatar(profile.id)?.bytes).toEqual(bytes);
});
