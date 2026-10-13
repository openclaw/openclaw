import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { onUserProfilesChanged } from "./user-profile-events.js";
import {
  getUserProfileDisplay,
  readUserProfileIdentity,
  prepareUserProfileCatalog,
} from "./user-profile-list.js";
import { linkEmail } from "./user-profile-writes.worker.js";
import { getProfileAvatar } from "./user-profiles-avatar.test-support.js";
import { adoptTailscaleProfileAvatar, ensureProfileForEmail } from "./user-profiles.js";

const delivery = vi.hoisted(() => ({ fail: false }));
vi.mock("./openclaw-state-worker-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-worker-store.js")>();
  return {
    ...actual,
    runOpenClawStateWorkerOperation: (
      context: Parameters<typeof actual.runOpenClawStateWorkerOperation>[0],
      operation: Parameters<typeof actual.runOpenClawStateWorkerOperation>[1],
      options: Parameters<typeof actual.runOpenClawStateWorkerOperation>[2],
    ) =>
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
  };
});

it("publishes the known avatar commit even when ordinary result delivery fails", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "avatar-receipt-" });
  let release = () => {};
  try {
    const profile = ensureProfileForEmail("receipt@example.test");
    release = (await prepareUserProfileCatalog()).release;
    const bytes = Uint8Array.from(readFileSync(join(process.cwd(), "ui/public/favicon-32.png")));
    delivery.fail = true;
    await expect(
      adoptTailscaleProfileAvatar(
        profile.id,
        "https://avatars.example.test/p",
        {},
        {
          fetchImpl: vi.fn(
            async () =>
              new Response(bytes.slice().buffer, {
                headers: { "content-type": "image/png" },
              }),
          ),
        },
      ),
    ).rejects.toThrow("synthetic result delivery failure");
    expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(true);
    expect(getProfileAvatar(profile.id)?.bytes).toEqual(bytes);
  } finally {
    delivery.fail = false;
    release();
    await state.cleanup();
  }
});

it("adopts an avatar off-thread and publishes its catalog before identity observers", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "avatar-worker-" });
  let release = () => {};
  let stop = () => {};
  try {
    const profile = ensureProfileForEmail("portrait@example.test");
    const alias = ensureProfileForEmail("alias@example.test");
    linkEmail("alias@example.test", profile.id);
    release = (await prepareUserProfileCatalog()).release;
    const seen: unknown[] = [];
    stop = onUserProfilesChanged(() => {
      seen.push({
        display: getUserProfileDisplay(alias.id),
        identity: readUserProfileIdentity(alias.id),
      });
    });
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    const bytes = Uint8Array.from(readFileSync(join(process.cwd(), "ui/public/favicon-32.png")));
    expect(
      await adoptTailscaleProfileAvatar(
        alias.id,
        "https://avatars.example.test/p",
        {},
        {
          fetchImpl: vi.fn(
            async () =>
              new Response(bytes.slice().buffer, {
                headers: { "content-type": "image/png" },
              }),
          ),
        },
      ),
    ).toMatchObject({ id: profile.id, avatarMime: "image/png" });
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
  } finally {
    vi.restoreAllMocks();
    stop();
    release();
    await state.cleanup();
  }
});
