import { afterEach, expect, test, vi } from "vitest";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import * as groups from "../session-groups.js";
import {
  directSessionReq,
  setupGatewaySessionsHandlerTestHarness,
} from "../test/server-sessions.test-helpers.js";
import { sessionLog } from "./sessions-shared.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
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
    "failed to register created session category: registration unavailable",
  );
});
