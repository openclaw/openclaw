import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { readUserProfileVersion } from "./user-profile-events.js";
import {
  getUserProfileDisplay,
  readUserProfileIdentity,
  retainUserProfileCatalog,
} from "./user-profile-list.js";
import {
  adoptTailscaleProfileAvatar,
  ensureProfileForEmail,
  getProfileAvatar,
  UserProfileNotFoundError,
} from "./user-profiles.js";
import { seedUserProfileRole } from "./user-profiles.test-support.js";

const boundary = vi.hoisted(() => ({
  beforeOperation: undefined as (() => void) | undefined,
  afterResult: undefined as (() => void) | undefined,
  duringGrant: undefined as (() => void) | undefined,
  bindFailure: undefined as Error | undefined,
  readFailure: undefined as Error | undefined,
  identityFailure: undefined as Error | undefined,
}));
vi.mock("../infra/sqlite-worker-identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-worker-identity.js")>();
  return {
    ...actual,
    assertExistingDatabaseIdentity: (
      ...args: Parameters<typeof actual.assertExistingDatabaseIdentity>
    ) => {
      if (boundary.identityFailure) {
        throw boundary.identityFailure;
      }
      actual.assertExistingDatabaseIdentity(...args);
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
    ) => {
      boundary.beforeOperation?.();
      return actual.runOpenClawStateWorkerOperation(
        context,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === "userProfiles.avatar.adopt") {
                boundary.afterResult?.();
              }
              return result;
            },
          }),
        options,
      );
    },
  };
});
vi.mock("./user-profile-list.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./user-profile-list.js")>();
  return {
    ...actual,
    retainUserProfilePublication: (
      ...args: Parameters<typeof actual.retainUserProfilePublication>
    ) => {
      const publication = actual.retainUserProfilePublication(...args);
      try {
        boundary.duringGrant?.();
      } catch (error) {
        publication.release();
        throw error;
      }
      return publication;
    },
  };
});
vi.mock("./openclaw-state-settlement-read.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openclaw-state-settlement-read.js")>();
  return {
    ...actual,
    withOpenClawStateSettlementRead: (
      context: Parameters<typeof actual.withOpenClawStateSettlementRead>[0],
      operation: Parameters<typeof actual.withOpenClawStateSettlementRead>[1],
    ) =>
      actual.withOpenClawStateSettlementRead(context, (read) =>
        operation({
          ...read,
          bind: (...args: Parameters<typeof read.bind>) => {
            if (boundary.bindFailure) {
              throw boundary.bindFailure;
            }
            read.bind(...args);
          },
        }),
      ),
  };
});
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
          if (boundary.readFailure) {
            throw boundary.readFailure;
          }
          return owned.read(...readArgs);
        },
      };
    },
  };
});
afterEach(() => {
  boundary.beforeOperation = undefined;
  boundary.afterResult = undefined;
  boundary.duringGrant = undefined;
  boundary.bindFailure = undefined;
  boundary.readFailure = undefined;
  boundary.identityFailure = undefined;
  vi.restoreAllMocks();
});

function fetchedAvatar() {
  const bytes = readFileSync(join(process.cwd(), "ui/public/favicon-32.png"));
  return {
    fetchImpl: vi.fn(
      async () =>
        new Response(Uint8Array.from(bytes).buffer, { headers: { "content-type": "image/png" } }),
    ),
  };
}

it("checks original source identity before publishing an acknowledged avatar receipt", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "avatar-receipt-identity-",
  });
  let release = () => {};
  let closing: Promise<unknown> | undefined;
  try {
    const profile = ensureProfileForEmail("receipt-identity@example.test");
    const pathname = openOpenClawStateDatabase().path;
    release = retainUserProfileCatalog();
    boundary.afterResult = () => {
      boundary.identityFailure = new Error("synthetic source identity changed after commit");
      closing = closeOpenClawStateDatabaseByPathAsync(pathname);
      void closing.catch(() => {});
    };
    await expect(
      adoptTailscaleProfileAvatar(
        profile.id,
        "https://avatars.example.test/p",
        {},
        fetchedAvatar(),
      ),
    ).rejects.toThrow();
    await expect(closing).rejects.toThrow("identity changed");
    expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(false);
    boundary.identityFailure = undefined;
    await closeOpenClawStateDatabaseByPathAsync(pathname);
    expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(true);
    expect(getProfileAvatar(profile.id)).toBeDefined();
  } finally {
    boundary.identityFailure = undefined;
    await Promise.allSettled([closing]);
    release();
    await state.cleanup();
  }
});

it("preserves a native first-use role in avatar publication after warming a legacy worker", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "avatar-legacy-role-",
  });
  let release = () => {};
  try {
    const { db } = openOpenClawStateDatabase();
    db.exec(`CREATE TABLE user_profiles (
      id TEXT NOT NULL PRIMARY KEY, display_name TEXT, avatar BLOB, avatar_mime TEXT,
      avatar_sha256 TEXT, merged_into TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`);
    const profile = ensureProfileForEmail("legacy-avatar@example.test");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    await adoptTailscaleProfileAvatar(profile.id, undefined);
    expect(tableHasColumn(db, "user_profiles", "role")).toBe(false);
    seedUserProfileRole(profile.id, "reader");
    release = retainUserProfileCatalog();
    const adopted = await adoptTailscaleProfileAvatar(
      profile.id,
      "https://avatars.example.test/p",
      {},
      fetchedAvatar(),
    );
    expect(adopted.role).toBe("reader");
    expect(readUserProfileIdentity(profile.id)?.role).toBe("reader");
    expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(true);
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(version);
  } finally {
    release();
    await state.cleanup();
  }
});

it("preserves the profile owner's missing-profile error through worker inspection", async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "avatar-missing-" });
  try {
    ensureProfileForEmail("existing@example.test");
    await expect(adoptTailscaleProfileAvatar("missing-profile", undefined)).rejects.toBeInstanceOf(
      UserProfileNotFoundError,
    );
  } finally {
    await state.cleanup();
  }
});

it("joins close when avatar admission never enters its worker callback", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "avatar-pre-dispatch-",
  });
  let closing: Promise<unknown> | undefined;
  try {
    const profile = ensureProfileForEmail("closed@example.test");
    const pathname = openOpenClawStateDatabase().path;
    boundary.beforeOperation = () => {
      closing = closeOpenClawStateDatabaseByPathAsync(pathname);
    };
    await expect(
      adoptTailscaleProfileAvatar(
        profile.id,
        "https://avatars.example.test/p",
        {},
        fetchedAvatar(),
      ),
    ).rejects.toThrow("closed");
    await closing;
    expect(getProfileAvatar(profile.id)).toBeUndefined();
  } finally {
    await closing;
    await state.cleanup();
  }
});

it("releases provisional catalog custody when transaction binding refuses", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "avatar-bind-refusal-",
  });
  let release = () => {};
  try {
    const profile = ensureProfileForEmail("binding@example.test");
    release = retainUserProfileCatalog();
    const version = readUserProfileVersion();
    boundary.bindFailure = new Error("synthetic binding refusal");
    await expect(
      adoptTailscaleProfileAvatar(
        profile.id,
        "https://avatars.example.test/p",
        {},
        fetchedAvatar(),
      ),
    ).rejects.toThrow("synthetic binding refusal");
    expect(getProfileAvatar(profile.id)).toBeUndefined();
    expect(readUserProfileVersion()).toBe(version);
    release();
    const prepare = vi.spyOn(requireNodeSqlite().DatabaseSync.prototype, "prepare");
    expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(false);
    expect(prepare).toHaveBeenCalled();
    prepare.mockRestore();
  } finally {
    release();
    await state.cleanup();
  }
});

it.each([false, true])(
  "publishes to a catalog retained before commit (previous catalog=%s)",
  async (resident) => {
    const state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "avatar-precommit-catalog-",
    });
    let release = () => {};
    try {
      const profile = ensureProfileForEmail("precommit@example.test");
      if (resident) {
        release = retainUserProfileCatalog();
      }
      let prepared = false;
      boundary.duringGrant = () => {
        release();
        release = retainUserProfileCatalog();
        expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(false);
        prepared = true;
      };
      await adoptTailscaleProfileAvatar(
        profile.id,
        "https://avatars.example.test/p",
        {},
        fetchedAvatar(),
      );
      expect(prepared).toBe(true);
      expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(true);
      expect(readUserProfileIdentity(profile.id)?.profileId).toBe(profile.id);
    } finally {
      release();
      await state.cleanup();
    }
  },
);

it("refuses a replacement source during settlement and retries only the original inode", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "avatar-source-replacement-",
  });
  let release = () => {};
  let closing: Promise<unknown> | undefined;
  let pathname: string | undefined;
  let saved: string | undefined;
  try {
    const profile = ensureProfileForEmail("replacement@example.test");
    pathname = openOpenClawStateDatabase().path;
    saved = `${pathname}.original`;
    release = retainUserProfileCatalog();
    await closeOpenClawStateDatabaseByPathAsync(pathname);
    boundary.readFailure = new Error("synthetic initial reconciliation failure");
    boundary.afterResult = () => {
      closing = closeOpenClawStateDatabaseByPathAsync(pathname!);
      void closing.catch(() => {});
      throw new Error("synthetic result delivery failure");
    };
    await expect(
      adoptTailscaleProfileAvatar(
        profile.id,
        "https://avatars.example.test/p",
        {},
        fetchedAvatar(),
      ),
    ).rejects.toThrow();
    await expect(closing).rejects.toThrow();
    // The writer has exited; simulate an out-of-band replacement of task-owned bytes.
    renameSync(pathname, saved);
    copyFileSync(saved, pathname);
    const replacement = readFileSync(pathname);
    boundary.readFailure = undefined;
    await expect(closeOpenClawStateDatabaseByPathAsync(pathname)).rejects.toThrow(
      "identity changed",
    );
    expect(readFileSync(pathname)).toEqual(replacement);
    expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(false);
    unlinkSync(pathname);
    renameSync(saved, pathname);
    await closeOpenClawStateDatabaseByPathAsync(pathname);
    expect(getUserProfileDisplay(profile.id).hasAvatar).toBe(true);
    expect(getProfileAvatar(profile.id)).toBeDefined();
  } finally {
    boundary.readFailure = undefined;
    if (pathname && saved && existsSync(saved)) {
      if (existsSync(pathname)) {
        unlinkSync(pathname);
      }
      renameSync(saved, pathname);
    }
    await Promise.allSettled([closing]);
    release();
    await state.cleanup();
  }
});
