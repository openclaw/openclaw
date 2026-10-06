import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRetainedOperation } from "@openclaw/worker-runtime/lifecycle";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import type { OpenClawStateReadOutcome } from "./openclaw-state-read.types.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { onUserProfilesChanged, readUserProfileVersion } from "./user-profile-events.js";
import {
  getUserProfileDisplay,
  readUserProfileIdentity,
  retainUserProfileCatalog,
} from "./user-profile-list.js";
import { linkEmail, setAvatar, setDisplayName } from "./user-profile-writes.worker.js";
import { getProfileAvatar } from "./user-profiles-avatar.test-support.js";
import { adoptTailscaleProfileAvatar, ensureProfileForEmail } from "./user-profiles.js";

const delivery = vi.hoisted(() => ({
  afterResult: undefined as (() => Promise<void>) | undefined,
  afterRead: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("./openclaw-state-read-worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-read-worker.js")>();
  return {
    ...actual,
    captureOpenClawStateReadSource: () => {
      const source = actual.captureOpenClawStateReadSource();
      return {
        ...source,
        createTransport: (...args: Parameters<typeof source.createTransport>) => {
          const owned = source.createTransport(...args);
          return {
            ...owned,
            startRead: (...readArgs: Parameters<typeof owned.startRead>) => {
              const read = owned.startRead(...readArgs);
              const completion = createRetainedOperation<OpenClawStateReadOutcome>(() =>
                read.service(),
              );
              void read.result
                .then(async (outcome) => {
                  await delivery.afterRead?.();
                  return outcome;
                })
                .then(completion.resolve, completion.reject);
              return completion.operation;
            },
          };
        },
      };
    },
  };
});
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
              if (command.type === "userProfiles.avatar.adopt") {
                await delivery.afterResult?.();
              }
              return result;
            },
          }),
        options,
      ),
  };
});

const bytes = Uint8Array.from(readFileSync(join(process.cwd(), "ui/public/favicon-32.png")));
function adoptAvatar(profileId: string) {
  return adoptTailscaleProfileAvatar(
    profileId,
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
  );
}

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeEach(async () => {
  state = await createOpenClawTestState({ layout: "state-only", prefix: "avatar-worker-" });
});
afterEach(async () => {
  delivery.afterResult = undefined;
  delivery.afterRead = undefined;
  await state.cleanup();
});

it.each([
  ["settlement read", "edit"],
  ["settlement read", "merge"],
  ["settlement read", "late catalog"],
  ["result", "close"],
  ["result", "edit"],
  ["result", "merge"],
  ["result", "late catalog"],
] as const)(
  "preserves avatar publication during %s delivery across %s",
  async (stage, boundary) => {
    const received = createDeferredCore();
    const resume = createDeferredCore();
    let release = () => {};
    let stop = () => {};
    let pending: Promise<unknown> | undefined;
    let closing: Promise<unknown> | undefined;
    try {
      const profile = ensureProfileForEmail("portrait@example.test");
      const target = ensureProfileForEmail("target@example.test");
      const alias = ensureProfileForEmail("alias@example.test");
      linkEmail("alias@example.test", profile.id);
      const pathname = openOpenClawStateDatabase().path;
      if (boundary !== "late catalog") {
        release = retainUserProfileCatalog();
      }
      const observed: Array<ReturnType<typeof getUserProfileDisplay>> = [];
      if (stage === "result") {
        stop = onUserProfilesChanged(() => {
          observed.push(getUserProfileDisplay(alias.id));
        });
      }
      const holdDelivery = async () => {
        received.resolve();
        await resume.promise;
      };
      delivery.afterResult =
        stage === "result"
          ? holdDelivery
          : async () => {
              throw new Error("synthetic result delivery failure");
            };
      if (stage === "settlement read") {
        delivery.afterRead = holdDelivery;
      }
      pending = adoptAvatar(alias.id);
      void pending.catch(() => {});
      await received.promise;
      if (stage === "result") {
        expect(getProfileAvatar(profile.id)?.bytes).toEqual(bytes);
      }
      let closeComplete = false;
      const replacesAvatar =
        boundary === "edit" || (stage === "settlement read" && boundary === "late catalog");
      if (boundary === "close") {
        closing = closeOpenClawStateDatabaseByPathAsync(pathname).then(() => {
          closeComplete = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(closeComplete).toBe(false);
      } else if (boundary === "merge") {
        linkEmail("portrait@example.test", target.id);
        linkEmail("alias@example.test", target.id);
      } else {
        setDisplayName(profile.id, "Newer name");
        if (replacesAvatar) {
          expect(setAvatar(profile.id, new Uint8Array([9]), "image/png").ok).toBe(true);
        }
        if (boundary === "late catalog") {
          release = retainUserProfileCatalog();
        }
      }
      if (stage === "settlement read") {
        closing = closeOpenClawStateDatabaseByPathAsync(pathname);
      }
      resume.resolve();
      if (stage === "settlement read") {
        await expect(pending).rejects.toThrow("synthetic result delivery failure");
      } else {
        await pending;
      }
      await closing;
      const expectedId = boundary === "merge" ? target.id : profile.id;
      expect(getUserProfileDisplay(alias.id)).toMatchObject({
        id: expectedId,
        hasAvatar: true,
        ...(boundary === "close" || boundary === "merge" ? {} : { displayName: "Newer name" }),
      });
      expect(readUserProfileIdentity(alias.id)?.aliases).toContain(alias.id);
      if (stage === "result") {
        expect(readUserProfileIdentity(alias.id)?.profileId).toBe(expectedId);
        expect(observed.at(-1)).toEqual(getUserProfileDisplay(alias.id));
      }
      if (replacesAvatar) {
        expect(getProfileAvatar(profile.id)?.bytes).toEqual(new Uint8Array([9]));
      }
      if (boundary === "close") {
        expect(closeComplete).toBe(true);
      }
    } finally {
      resume.resolve();
      await Promise.allSettled([pending, closing]);
      stop();
      release();
    }
  },
);

it.each(["resident", "absent", "late"] as const)(
  "retains committed avatar catalog reconciliation when result delivery fails during close (%s)",
  async (catalog) => {
    let release = () => {};
    let closing: Promise<unknown> | undefined;
    try {
      const profile = ensureProfileForEmail("result-loss@example.test");
      const pathname = openOpenClawStateDatabase().path;
      const admission = captureOpenClawStateWorkerContext({ path: pathname }).admission;
      if (catalog === "resident") {
        release = retainUserProfileCatalog();
      }
      const version = readUserProfileVersion();
      delivery.afterResult = async () => {
        if (catalog === "late") {
          release = retainUserProfileCatalog();
        }
        closing = closeOpenClawStateDatabaseByPathAsync(pathname);
        expect(() => admission.assertCurrent()).toThrow();
        throw new Error("synthetic result delivery failure");
      };
      await expect(adoptAvatar(profile.id)).rejects.toThrow("synthetic result delivery failure");
      await closing;
      expect(getProfileAvatar(profile.id)?.bytes).toEqual(bytes);
      expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(true);
      expect(readUserProfileVersion()).toBe(version + 1);
    } finally {
      await closing;
      release();
    }
  },
);

it("preserves an explicit empty avatar without fetching", async () => {
  const profile = ensureProfileForEmail("explicit@example.test");
  const empty = new Uint8Array();
  expect(setAvatar(profile.id, empty, "image/png").ok).toBe(true);
  const fetchImpl = vi.fn();
  await expect(
    adoptTailscaleProfileAvatar(profile.id, "https://avatars.example.test/p", {}, { fetchImpl }),
  ).resolves.toMatchObject({ id: profile.id, avatarMime: "image/png" });
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(getProfileAvatar(profile.id)?.bytes).toEqual(empty);
});

it("adopts an avatar off-thread and publishes its catalog before identity observers", async () => {
  let release = () => {};
  let stop = () => {};
  try {
    const profile = ensureProfileForEmail("portrait@example.test");
    const alias = ensureProfileForEmail("alias@example.test");
    linkEmail("alias@example.test", profile.id);
    release = retainUserProfileCatalog();
    const seen: unknown[] = [];
    stop = onUserProfilesChanged(() => {
      seen.push({
        display: getUserProfileDisplay(alias.id),
        identity: readUserProfileIdentity(alias.id),
      });
    });
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    expect(await adoptAvatar(alias.id)).toMatchObject({ id: profile.id, avatarMime: "image/png" });
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
  }
});
