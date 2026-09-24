import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import * as categories from "../../config/sessions/session-group-categories.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import * as groups from "../session-groups.js";
import { testState } from "../test-helpers.runtime-state.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { sessionLog } from "./sessions-shared.js";

const { createSessionStoreDir, createSelectedGlobalSessionStore } =
  setupGatewaySessionsHandlerTestHarness();

test.each(["create", "patch"] as const)(
  "keeps %s registration ahead of group deletion",
  async (operation) => {
    const { storePath } = await createSessionStoreDir();
    const key = `agent:main:dashboard:registration-delete-${operation}`;
    expect((await directSessionReq("sessions.groups.put", { names: ["Race"] })).ok).toBe(true);
    if (operation === "patch") {
      expect((await directSessionReq("sessions.create", { agentId: "main", key })).ok).toBe(true);
    }
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const order: string[] = [];
    const register = groups.ensureSessionGroupRegistered;
    vi.spyOn(groups, "ensureSessionGroupRegistered").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      const changed = await register(...args);
      order.push("registered");
      return changed;
    });
    const writing = directSessionReq(
      operation === "create" ? "sessions.create" : "sessions.patch",
      { agentId: "main", key, category: "Race" },
    );
    await Promise.race([
      entered.promise,
      writing.then(() => {
        throw new Error("write did not enter registration");
      }),
    ]);
    const queued = createDeferredCore();
    const sweep = categories.updateSessionGroupCategoriesInWorker;
    let waitingBehindRegistration = false;
    vi.spyOn(categories, "updateSessionGroupCategoriesInWorker").mockImplementation((params) => {
      const deleting = sweep(params);
      const path = resolveOpenClawAgentSqlitePath(
        toDatabaseOptions(resolveSqliteScope(params.scope)),
      );
      waitingBehindRegistration = (SQLITE_SESSION_WRITER_QUEUES.get(path)?.pending.length ?? 0) > 0;
      queued.resolve();
      return deleting;
    });
    const deleting = directSessionReq("sessions.groups.delete", { name: "Race" }).then((result) => {
      order.push("deleted");
      return result;
    });
    try {
      await Promise.race([
        queued.promise,
        deleting.then(() => {
          throw new Error("delete did not enqueue its member sweep");
        }),
      ]);
    } finally {
      release.resolve();
      await Promise.all([writing, deleting]);
    }
    expect(waitingBehindRegistration).toBe(true);
    expect((await writing).ok).toBe(true);
    expect((await deleting).ok).toBe(true);
    expect(order).toEqual(["registered", "deleted"]);
    expect(
      loadSessionEntry({ agentId: "main", storePath, sessionKey: key })?.category,
    ).toBeUndefined();
    expect(groups.listSessionGroups().map(({ name }) => name)).not.toContain("Race");
  },
);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.restoreAllMocks();
});

test("creates and patches first-use groups before publishing their invalidation", async () => {
  await createSessionStoreDir();
  const observedGroups: string[][] = [];
  const context = {
    getSessionEventSubscriberConnIds: () => new Set(["group-observer"]),
    broadcastToConnIds: (_event: string, payload: { reason?: string }) => {
      if (payload.reason === "groups") {
        observedGroups.push(groups.listSessionGroups().map(({ name }) => name));
      }
    },
  };
  const key = "agent:main:dashboard:group-publication";
  const created = await directSessionReq(
    "sessions.create",
    { agentId: "main", key, category: "Created" },
    { context },
  );
  expect(created.ok).toBe(true);
  expect(observedGroups).toEqual([expect.arrayContaining(["Created"])]);

  const patched = await directSessionReq(
    "sessions.patch",
    { key, category: "Patched" },
    { context },
  );
  expect(patched.ok).toBe(true);
  expect(observedGroups).toEqual([
    expect.arrayContaining(["Created"]),
    expect.arrayContaining(["Created", "Patched"]),
  ]);
  expect(
    (await directSessionReq("sessions.patch", { key, category: "Patched" }, { context })).ok,
  ).toBe(true);
  expect(observedGroups).toHaveLength(2);
});

test("joins rejected post-commit group registration before reporting durable create success", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:group-warning";
  const entered = createDeferredCore();
  const registration = createDeferredCore<boolean>();
  let registering = false;
  vi.spyOn(groups, "ensureSessionGroupRegistered").mockImplementation(() => {
    registering = true;
    entered.resolve();
    return registration.promise;
  });
  const warn = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
  let replied = false;
  const creating = directSessionReq(
    "sessions.create",
    { agentId: "main", key, category: "Retained" },
    {
      coercePayload: (payload) => {
        replied = true;
        return payload;
      },
    },
  );
  try {
    await Promise.race([
      entered.promise,
      creating.then(() => {
        throw new Error("create finished before category registration");
      }),
    ]);
    expect(loadSessionEntry({ agentId: "main", storePath, sessionKey: key })?.category).toBe(
      "Retained",
    );
    expect(replied).toBe(false);
  } finally {
    if (registering) {
      registration.reject(new Error("registration unavailable"));
    } else {
      registration.resolve(false);
    }
    await creating;
  }
  expect((await creating).ok).toBe(true);
  expect(loadSessionEntry({ agentId: "main", storePath, sessionKey: key })?.category).toBe(
    "Retained",
  );
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining(
      "retry the same category assignment to repair the catalog: registration unavailable",
    ),
  );
  vi.mocked(groups.ensureSessionGroupRegistered).mockRestore();
  expect((await directSessionReq("sessions.patch", { key, category: "Retained" })).ok).toBe(true);
  expect(groups.listSessionGroups().map(({ name }) => name)).toContain("Retained");
});

test("does not register an unapplied category on the reset-main creation path", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main" };
  expect(
    (await directSessionReq("sessions.create", { agentId: "main", key: "agent:main:main" })).ok,
  ).toBe(true);
  const reset = await directSessionReq<{ key: string; entry: { category?: string } }>(
    "sessions.create",
    {
      parentSessionKey: "agent:main:main",
      emitCommandHooks: true,
      category: "Unapplied",
    },
  );
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.category).toBeUndefined();
  const listed = await directSessionReq<{ groups: Array<{ name: string }> }>(
    "sessions.groups.list",
    {},
  );
  expect(listed.payload?.groups.map(({ name }) => name)).not.toContain("Unapplied");
});

test("registers committed patchMany categories across physical stores", async () => {
  const stores = await createSelectedGlobalSessionStore();
  const targets = ["main", "work"].map((agentId) => ({
    agentId,
    key: `agent:${agentId}:dashboard:batch-category`,
  }));
  for (const target of targets) {
    expect((await directSessionReq("sessions.create", target)).ok).toBe(true);
  }
  expect(
    (
      await directSessionReq("sessions.patchMany", {
        targets,
        patch: { category: "Shared category" },
      })
    ).ok,
  ).toBe(true);
  for (const target of targets) {
    expect(
      loadSessionEntry({
        agentId: target.agentId,
        sessionKey: target.key,
        storePath: target.agentId === "main" ? stores.mainStorePath : stores.workStorePath,
      })?.category,
    ).toBe("Shared category");
  }
  expect(groups.listSessionGroups().map(({ name }) => name)).toContain("Shared category");
});
