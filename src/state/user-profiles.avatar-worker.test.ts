import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { acquireStateDatabaseHandleExclusion } from "../infra/state-database-coordinator.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { onUserProfilesChanged, readUserProfileVersion } from "./user-profile-events.js";
import {
  getUserProfileDisplay,
  readUserProfileIdentity,
  retainUserProfileCatalog,
} from "./user-profile-list.js";
import {
  adoptTailscaleProfileAvatar,
  ensureProfileForEmail,
  getProfileAvatar,
  linkEmail,
  setAvatar,
  setDisplayName,
} from "./user-profiles.js";

const delivery = vi.hoisted(() => ({
  afterResult: undefined as (() => Promise<void>) | undefined,
  readFailure: undefined as Error | undefined,
  closeFailure: undefined as Error | undefined,
  afterRead: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("./openclaw-state-read-worker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-read-worker.js")>();
  return {
    ...actual,
    createOpenClawStateReadTransport: (
      ...args: Parameters<typeof actual.createOpenClawStateReadTransport>
    ) => {
      const owned = actual.createOpenClawStateReadTransport(...args);
      return {
        ...owned,
        read: async (...readArgs: Parameters<typeof owned.read>) => {
          if (delivery.readFailure) {
            throw delivery.readFailure;
          }
          const result = await owned.read(...readArgs);
          await delivery.afterRead?.();
          return result;
        },
        close: async () => {
          if (delivery.closeFailure) {
            throw delivery.closeFailure;
          }
          await owned.close();
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

afterEach(() => {
  delivery.afterResult = undefined;
  delivery.readFailure = undefined;
  delivery.closeFailure = undefined;
  delivery.afterRead = undefined;
});

it.each(["edit", "merge", "late catalog"] as const)(
  "preserves newer %s during settlement read publication",
  async (boundary) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "avatar-read-race-",
    });
    const read = createDeferredCore();
    const resume = createDeferredCore();
    let release = () => {};
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
      delivery.afterResult = async () => {
        throw new Error("synthetic result delivery failure");
      };
      delivery.afterRead = async () => {
        read.resolve();
        await resume.promise;
      };
      const bytes = readFileSync(join(process.cwd(), "ui/public/favicon-32.png"));
      pending = adoptTailscaleProfileAvatar(
        alias.id,
        "https://avatars.example.test/p",
        {},
        {
          fetchImpl: vi.fn(
            async () =>
              new Response(Uint8Array.from(bytes).buffer, {
                headers: { "content-type": "image/png" },
              }),
          ),
        },
      );
      void pending.catch(() => {});
      await read.promise;
      if (boundary === "merge") {
        linkEmail("portrait@example.test", target.id);
        linkEmail("alias@example.test", target.id);
      } else {
        setDisplayName(profile.id, "After recovery snapshot");
        expect(setAvatar(profile.id, new Uint8Array([9]), "image/png").ok).toBe(true);
        if (boundary === "late catalog") {
          release = retainUserProfileCatalog();
        }
      }
      closing = closeOpenClawStateDatabaseByPathAsync(pathname);
      resume.resolve();
      await expect(pending).rejects.toThrow("synthetic result delivery failure");
      await closing;
      expect(getUserProfileDisplay(alias.id)).toMatchObject({
        id: boundary === "merge" ? target.id : profile.id,
        hasAvatar: true,
        ...(boundary === "merge" ? {} : { displayName: "After recovery snapshot" }),
      });
      expect(readUserProfileIdentity(alias.id)?.aliases).toContain(alias.id);
      if (boundary !== "merge") {
        expect(getProfileAvatar(profile.id)?.bytes).toEqual(new Uint8Array([9]));
      }
    } finally {
      resume.resolve();
      await Promise.allSettled([pending, closing]);
      release();
      await state.cleanup();
    }
  },
);

it.each(["read", "retirement", "both"] as const)(
  "retains original source custody for a failed settlement %s and canonical retry",
  async (failure) => {
    const state = await createOpenClawTestState({ layout: "state-only", prefix: "avatar-retry-" });
    let release = () => {};
    let closing: Promise<unknown> | undefined;
    const originalFailure = new Error("synthetic result delivery failure");
    const queryFailure = new Error("synthetic settlement query failure");
    const retirementFailure = new Error("synthetic settlement retirement failure");
    try {
      const profile = ensureProfileForEmail("retry@example.test");
      const pathname = openOpenClawStateDatabase().path;
      release = retainUserProfileCatalog();
      await closeOpenClawStateDatabaseByPathAsync(pathname);
      delivery.readFailure = failure === "retirement" ? undefined : queryFailure;
      delivery.closeFailure = failure === "read" ? undefined : retirementFailure;
      delivery.afterResult = async () => {
        closing = closeOpenClawStateDatabaseByPathAsync(pathname);
        void closing.catch(() => {});
        throw originalFailure;
      };
      const bytes = readFileSync(join(process.cwd(), "ui/public/favicon-32.png"));
      const failed = await adoptTailscaleProfileAvatar(
        profile.id,
        "https://avatars.example.test/p",
        {},
        {
          fetchImpl: vi.fn(
            async () =>
              new Response(Uint8Array.from(bytes).buffer, {
                headers: { "content-type": "image/png" },
              }),
          ),
        },
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failed).toMatchObject({ errors: expect.arrayContaining([originalFailure]) });
      if (failure === "both") {
        expect(failed).toMatchObject({
          errors: [
            originalFailure,
            expect.objectContaining({ errors: [queryFailure, retirementFailure] }),
          ],
        });
      }
      await expect(closing).rejects.toThrow();
      expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(false);
      expect(() =>
        acquireStateDatabaseHandleExclusion({ databasePath: pathname, busyTimeoutMs: 0 }),
      ).toThrow();
      delivery.readFailure = undefined;
      delivery.closeFailure = undefined;
      await closeOpenClawStateDatabaseByPathAsync(pathname);
      const exclusion = acquireStateDatabaseHandleExclusion({
        databasePath: pathname,
        busyTimeoutMs: 0,
      });
      exclusion.release();
      expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(true);
      expect(getProfileAvatar(profile.id)?.bytes).toEqual(Uint8Array.from(bytes));
    } finally {
      delivery.readFailure = undefined;
      delivery.closeFailure = undefined;
      await Promise.allSettled([closing]);
      release();
      await state.cleanup();
    }
  },
);

it.each(["resident", "absent", "late"] as const)(
  "retains committed avatar catalog reconciliation when result delivery fails during close (%s)",
  async (catalog) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "avatar-result-loss-",
    });
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
      const bytes = readFileSync(join(process.cwd(), "ui/public/favicon-32.png"));
      delivery.afterResult = async () => {
        if (catalog === "late") {
          release = retainUserProfileCatalog();
        }
        closing = closeOpenClawStateDatabaseByPathAsync(pathname);
        expect(() => admission.assertCurrent()).toThrow();
        throw new Error("synthetic result delivery failure");
      };
      await expect(
        adoptTailscaleProfileAvatar(
          profile.id,
          "https://avatars.example.test/p",
          {},
          {
            fetchImpl: vi.fn(
              async () =>
                new Response(Uint8Array.from(bytes).buffer, {
                  headers: { "content-type": "image/png" },
                }),
            ),
          },
        ),
      ).rejects.toThrow("synthetic result delivery failure");
      await closing;
      expect(getProfileAvatar(profile.id)?.bytes).toEqual(Uint8Array.from(bytes));
      expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(true);
      expect(readUserProfileVersion()).toBe(version + 1);
    } finally {
      await closing;
      release();
      await state.cleanup();
    }
  },
);

it.each([new Uint8Array(), new Uint8Array([9])])(
  "preserves an explicit non-null avatar %j without fetching",
  async (bytes) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "avatar-explicit-",
    });
    try {
      const profile = ensureProfileForEmail("explicit@example.test");
      expect(setAvatar(profile.id, bytes, "image/png").ok).toBe(true);
      const fetchImpl = vi.fn();
      await expect(
        adoptTailscaleProfileAvatar(
          profile.id,
          "https://avatars.example.test/p",
          {},
          { fetchImpl },
        ),
      ).resolves.toMatchObject({ id: profile.id, avatarMime: "image/png" });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(getProfileAvatar(profile.id)?.bytes).toEqual(bytes);
    } finally {
      await state.cleanup();
    }
  },
);

it("adopts an avatar off-thread and publishes its catalog before identity observers", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "avatar-worker-" });
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
    const bytes = readFileSync(join(process.cwd(), "ui/public/favicon-32.png"));
    const { DatabaseSync, StatementSync } = requireNodeSqlite();
    const calls = [
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      ),
    ];
    const adopted = await adoptTailscaleProfileAvatar(
      alias.id,
      "https://avatars.example.test/p",
      {},
      {
        fetchImpl: vi.fn(
          async () =>
            new Response(Uint8Array.from(bytes).buffer, {
              headers: { "content-type": "image/png" },
            }),
        ),
      },
    );
    expect(adopted).toMatchObject({ id: profile.id, avatarMime: "image/png" });
    expect(seen).toEqual([
      {
        display: expect.objectContaining({ id: profile.id, hasAvatar: true }),
        identity: { profileId: profile.id, role: null, aliases: new Set([profile.id, alias.id]) },
      },
    ]);
    expect(calls.map((call) => call.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    calls.forEach((call) => call.mockRestore());
    expect(getProfileAvatar(profile.id)?.bytes).toEqual(Uint8Array.from(bytes));
  } finally {
    vi.restoreAllMocks();
    stop();
    release();
    await state.cleanup();
  }
});

it.each(["close", "native edit", "native merge", "recreated catalog", "late catalog"] as const)(
  "preserves committed avatar publication through %s during result delivery",
  async (boundary) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "avatar-publication-",
    });
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
      stop = onUserProfilesChanged(() => {
        observed.push(getUserProfileDisplay(alias.id));
      });
      delivery.afterResult = async () => {
        received.resolve();
        await resume.promise;
      };
      const bytes = readFileSync(join(process.cwd(), "ui/public/favicon-32.png"));
      pending = adoptTailscaleProfileAvatar(
        alias.id,
        "https://avatars.example.test/p",
        {},
        {
          fetchImpl: vi.fn(
            async () =>
              new Response(Uint8Array.from(bytes).buffer, {
                headers: { "content-type": "image/png" },
              }),
          ),
        },
      );
      await received.promise;
      expect(getProfileAvatar(profile.id)?.bytes).toEqual(Uint8Array.from(bytes));
      let closeComplete = false;
      if (boundary === "close") {
        closing = closeOpenClawStateDatabaseByPathAsync(pathname).then(() => {
          closeComplete = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(closeComplete).toBe(false);
      } else if (boundary === "native merge") {
        linkEmail("portrait@example.test", target.id);
        linkEmail("alias@example.test", target.id);
      } else {
        if (boundary === "recreated catalog") {
          release();
          release = retainUserProfileCatalog();
        }
        setDisplayName(profile.id, "Newer name");
        if (boundary === "native edit") {
          expect(setAvatar(profile.id, new Uint8Array([9]), "image/png").ok).toBe(true);
        }
        if (boundary === "late catalog") {
          release = retainUserProfileCatalog();
        }
      }
      const expectedId = boundary === "native merge" ? target.id : profile.id;
      resume.resolve();
      await pending;
      await closing;
      expect(getUserProfileDisplay(alias.id)).toMatchObject({
        id: expectedId,
        hasAvatar: true,
        ...(boundary !== "close" && boundary !== "native merge"
          ? { displayName: "Newer name" }
          : {}),
      });
      expect(readUserProfileIdentity(alias.id)?.aliases).toContain(alias.id);
      expect(readUserProfileIdentity(alias.id)?.profileId).toBe(expectedId);
      expect(observed.at(-1)).toEqual(getUserProfileDisplay(alias.id));
      if (boundary === "native edit") {
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
      await state.cleanup();
    }
  },
);
