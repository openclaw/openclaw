import { beforeEach, expect, test } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { runSessionMutation } from "../sessions/session-controller.lifecycle.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const sessionKey = "agent:main:dreaming-narrative-owned";
const sessionId = "plugin-session";
let storePath: string;
beforeEach(async () => {
  ({ storePath } = await createSessionStoreDir());
});
const readEntry = (key = sessionKey) => loadSessionEntry({ sessionKey: key, storePath });
const ownedEntry = (pluginOwnerId = "memory-core") =>
  sessionStoreEntry(sessionId, { pluginOwnerId });
const pluginOptions = (scope: "operator.write" | "operator.admin") => ({
  client: {
    connect: { scopes: [scope] },
    internal: { pluginRuntimeOwnerId: "memory-core" },
  } as never,
});
const writeOptions = pluginOptions("operator.write");
const adminOptions = pluginOptions("operator.admin");
const patch = (key: string, label: string, options = adminOptions) =>
  directSessionReq("sessions.patch", { key, label }, options);
function expectDenied(result: unknown, action: "reset" | "patch", key: string) {
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: `Plugin "memory-core" cannot ${action} session "${key}" because it did not create it.`,
    },
  });
}

const seed = (pluginOwnerId = "memory-core") =>
  writeSessionStore({ entries: { [sessionKey]: ownedEntry(pluginOwnerId) } });

test("sessions.reset prevents a plugin from resetting another plugin's session", async () => {
  await seed("other-plugin");
  const reset = await directSessionReq("sessions.reset", { key: sessionKey }, writeOptions);
  expectDenied(reset, "reset", sessionKey);
  expect(readEntry()).toMatchObject({
    sessionId,
    pluginOwnerId: "other-plugin",
  });
});

test("sessions.reset stamps plugin ownership when it materializes a missing session", async () => {
  const reset = await directSessionReq("sessions.reset", { key: sessionKey }, writeOptions);

  expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
  expect(readEntry()).toMatchObject({
    pluginOwnerId: "memory-core",
  });

  const patched = await patch(sessionKey, "Reset-created plugin session", writeOptions);

  expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
});

test("sessions.reset rechecks plugin ownership inside lifecycle admission", async () => {
  await seed();
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  let replaced = false;

  const reset = await performGatewaySessionReset({
    key: sessionKey,
    reason: "reset",
    commandSource: "gateway:sessions.reset",
    workerPlacementContext: {},
    authorizedPluginId: "memory-core",
    assertCurrent: () => {
      if (replaced) {
        return;
      }
      replaced = true;
      replaceSessionEntrySync({ sessionKey, storePath }, ownedEntry("other-plugin"));
    },
  });

  expectDenied(reset, "reset", sessionKey);
  expect(readEntry()).toMatchObject({
    pluginOwnerId: "other-plugin",
    sessionId,
  });
});

test("sessions.patch limits plugin-runtime mutations to sessions owned by that plugin", async () => {
  const foreignKey = "agent:main:dreaming-narrative-foreign";
  const operatorKey = "agent:main:dashboard:operator-owned";
  await writeSessionStore({
    entries: {
      [sessionKey]: ownedEntry(),
      [foreignKey]: sessionStoreEntry("sess-foreign", { pluginOwnerId: "other-plugin" }),
      [operatorKey]: sessionStoreEntry("sess-operator"),
    },
  });
  for (const key of [foreignKey, operatorKey]) {
    const denied = await patch(key, "unauthorized mutation");
    expectDenied(denied, "patch", key);
    expect(readEntry(key)?.label).toBeUndefined();
  }

  const patched = await patch(sessionKey, "authorized mutation");

  expect(patched.ok, JSON.stringify(patched.error)).toBe(true);
  expect(readEntry()?.label).toBe("authorized mutation");
});

test("sessions.patch rechecks plugin ownership after waiting for lifecycle admission", async () => {
  await seed();
  const releaseMutation = createDeferred();
  const { promise: mutationStarted, resolve: markMutationStarted } = createDeferred();
  const mutation = runSessionMutation({
    scope: storePath,
    identities: [sessionKey, sessionId],
    run: async () => {
      markMutationStarted();
      await releaseMutation.promise;
    },
  });
  await mutationStarted;
  const pendingPatch = patch(sessionKey, "unauthorized raced mutation");
  await Promise.resolve();
  await replaceSessionEntry({ sessionKey, storePath }, ownedEntry("other-plugin"));
  releaseMutation.resolve();

  const [patched] = await Promise.all([pendingPatch, mutation]);

  expect(patched.ok).toBe(false);
  expect(patched.error?.message).toContain("did not create it");
  expect(readEntry()).toMatchObject({
    pluginOwnerId: "other-plugin",
  });
  expect(readEntry()?.label).toBeUndefined();
});
