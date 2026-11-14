import { afterEach, expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement as beforeReply } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import * as categories from "../../config/sessions/session-group-categories.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { readSessionGroupCatalog } from "../session-group-catalog.js";
import * as groups from "../session-groups.js";
import { disposeSessionReadContexts } from "../session-read-contexts.test-support.js";
import { loadGatewayTestConfig } from "../test-helpers.config-runtime.js";
import { testState } from "../test-helpers.runtime-state.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { sessionLog } from "./sessions-shared.js";

const { createSessionStoreDir, createSelectedGlobalSessionStore } =
  setupGatewaySessionsHandlerTestHarness();
const key = "agent:main:dashboard:category";
const groupNames = () => readSessionGroupCatalog().groups.map(({ name }) => name);
const categoryAt = (storePath: string, sessionKey: string, agentId = "main") =>
  loadSessionEntry({ agentId, storePath, sessionKey })?.category;
async function expectOk<T = unknown>(...args: Parameters<typeof directSessionReq<T>>) {
  const response = await directSessionReq<T>(...args);
  expect(response.ok).toBe(true);
  return response;
}

test.each(["create", "patch"] as const)(
  "keeps %s registration ahead of group deletion",
  async (operation) => {
    const { storePath } = await createSessionStoreDir();
    await expectOk("sessions.groups.put", { names: ["Race"] });
    if (operation === "patch") {
      await expectOk("sessions.create", { agentId: "main", key });
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
    const writing = expectOk(`sessions.${operation}`, { agentId: "main", key, category: "Race" });
    await beforeReply(entered.promise, writing, "write did not enter registration");
    const queued = createDeferredCore();
    const sweep = categories.updateSessionGroupCategoriesInWorker;
    vi.spyOn(categories, "updateSessionGroupCategoriesInWorker").mockImplementation((params) => {
      const deleting = sweep(params);
      queued.resolve();
      return deleting;
    });
    const deleting = expectOk("sessions.groups.delete", { name: "Race" }).then((result) => {
      order.push("deleted");
      return result;
    });
    try {
      await beforeReply(queued.promise, deleting, "delete did not enqueue its member sweep");
    } finally {
      release.resolve();
      await Promise.all([writing, deleting]);
    }
    expect(order).toEqual(["registered", "deleted"]);
    expect(categoryAt(storePath, key)).toBeUndefined();
    expect(groupNames()).not.toContain("Race");
  },
);
afterEach(async () => {
  await disposeSessionReadContexts();
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
        observedGroups.push(groupNames());
      }
    },
  };
  await expectOk("sessions.create", { agentId: "main", key, category: "Created" }, { context });
  expect(observedGroups).toEqual([expect.arrayContaining(["Created"])]);

  await expectOk("sessions.patch", { key, category: "Patched" }, { context });
  expect(observedGroups).toEqual([
    expect.arrayContaining(["Created"]),
    expect.arrayContaining(["Created", "Patched"]),
  ]);
  await expectOk("sessions.patch", { key, category: "Patched" }, { context });
  expect(observedGroups).toHaveLength(2);
});

test("joins rejected post-commit group registration before reporting durable create success", async () => {
  const { storePath } = await createSessionStoreDir();
  const entered = createDeferredCore();
  const registration = createDeferredCore<boolean>();
  const register = vi.spyOn(groups, "ensureSessionGroupRegistered").mockImplementation(() => {
    entered.resolve();
    return registration.promise;
  });
  const warn = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
  const reply = vi.fn((payload: unknown) => payload);
  const creating = expectOk(
    "sessions.create",
    { agentId: "main", key, category: "Retained" },
    { coercePayload: reply },
  );
  try {
    await beforeReply(entered.promise, creating, "create finished before category registration");
    expect(categoryAt(storePath, key)).toBe("Retained");
    expect(reply).not.toHaveBeenCalled();
  } finally {
    if (register.mock.calls.length) {
      registration.reject(new Error("registration unavailable"));
    } else {
      registration.resolve(false);
    }
    await creating;
  }
  expect(categoryAt(storePath, key)).toBe("Retained");
  const warning =
    "retry the same category assignment to repair the catalog: registration unavailable";
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(warning));
  register.mockRestore();
  await expectOk("sessions.patch", { key, category: "Retained" });
  expect(groupNames()).toContain("Retained");
});

test("does not register an unapplied category on the reset-main creation path", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { dmScope: "main" };
  setRuntimeConfigSnapshot(loadGatewayTestConfig());
  await expectOk("sessions.create", { agentId: "main", key: "agent:main:main" });
  const reset = await expectOk<{ key: string; entry: { category?: string } }>("sessions.create", {
    parentSessionKey: "agent:main:main",
    emitCommandHooks: true,
    category: "Unapplied",
  });
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
  const targets = (["main", "work"] as const).map((agentId) => ({
    agentId,
    key: `agent:${agentId}:dashboard:batch-category`,
  }));
  for (const target of targets) {
    await expectOk("sessions.create", target);
  }
  await expectOk("sessions.patchMany", { targets, patch: { category: "Shared category" } });
  const paths = { main: stores.mainStorePath, work: stores.workStorePath };
  for (const { agentId, key: targetKey } of targets) {
    expect(categoryAt(paths[agentId], targetKey, agentId)).toBe("Shared category");
  }
  expect(groupNames()).toContain("Shared category");
});
