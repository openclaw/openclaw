import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { normalizeWebPushNotificationPreferences } from "../../infra/push-web-preferences.js";
import { runWebPushStoreMutation } from "../../infra/push-web-store.scope.js";
import { registerWebPushSubscription } from "../../infra/push-web.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import * as preferences from "../../state/user-preferences.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { pushHandlers } from "./push.js";
import { holdPushStorage, pushClient } from "./push.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  vi.restoreAllMocks();
  await closeStateDatabaseForTest();
  vi.unstubAllEnvs();
});

it("runs web-push preference get and set without preparing SQLite on the calling thread", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-push-preferences-"));
  const profileId = ensureProfileForEmail("push-owner@example.test").id;
  const endpoint = new URL("/preferences", "https://push.example.test").href;
  await registerWebPushSubscription({
    endpoint,
    keys: { p256dh: ["synthetic", "p256dh"].join("-"), auth: ["synthetic", "auth"].join("-") },
    binding: { deviceId: "browser-device", userProfileId: profileId },
  });
  const native = vi.spyOn(DatabaseSync.prototype, "prepare");
  const order: string[] = [];
  const respond = vi.fn(() => order.push("response"));
  const options: Parameters<(typeof pushHandlers)["push.web.preferences.set"]>[0] = {
    req: { type: "req", id: "preferences", method: "push.web.preferences.set" },
    params: {
      endpoint,
      scope: "user",
      preferences: normalizeWebPushNotificationPreferences({ detailLevel: "detailed" }),
    },
    client: pushClient(
      profileId,
      "preferences-owner",
      new AbortController().signal,
      "browser-device",
      ["operator.read", "operator.write"],
    ),
    respond,
    isWebchatConnect: () => false,
    context: createDirectChatContext({ getRuntimeConfig: () => ({}), broadcastToConnIds: vi.fn() }),
  };
  options.context.getClientConnIds = (predicate) =>
    options.client && (!predicate || predicate(options.client))
      ? new Set(["preferences-owner"])
      : new Set();
  const storage = holdPushStorage();
  const write = preferences.setCanonicalUserPreferences;
  vi.spyOn(preferences, "setCanonicalUserPreferences").mockImplementationOnce(async (...args) => {
    await storage.wait();
    return write(...args);
  });
  const pending = Promise.resolve(pushHandlers["push.web.preferences.set"](options));
  let bindingMutation: Promise<void> | undefined;
  await storage.settle(pending, () => {
    bindingMutation = runWebPushStoreMutation(
      captureOpenClawStateWorkerContext(),
      undefined,
      async () => {
        order.push("binding mutation");
      },
    );
  });
  await bindingMutation;
  expect(order).toEqual(["response", "binding mutation"]);
  expect(options.context.broadcastToConnIds).toHaveBeenCalledWith(
    "users.prefs.changed",
    { profileId, keys: ["notifications.web.v1"] },
    new Set(["preferences-owner"]),
  );
  expect(respond.mock.calls.at(-1)).toEqual([
    true,
    { scope: "user", preferences: options.params.preferences },
    undefined,
  ]);
  await pushHandlers["push.web.preferences.get"]({
    ...options,
    req: { ...options.req, method: "push.web.preferences.get" },
    params: { endpoint },
  });
  expect(respond.mock.calls.at(-1)).toMatchObject([
    true,
    { durableIdentity: true, user: { detailLevel: "detailed" } },
    undefined,
  ]);
  expect(native).not.toHaveBeenCalled();
});
