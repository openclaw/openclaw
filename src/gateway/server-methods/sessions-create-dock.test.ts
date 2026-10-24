import { expect, test } from "vitest";
import { getRuntimeConfig } from "../../config/io.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { setupSessionCreateHandlerTestHarness } from "../server.sessions.create.test-support.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import { directSessionReq } from "../test/server-sessions.test-helpers.js";
import type { GatewayClient } from "./types.js";

const { createSessionStoreDir } = setupSessionCreateHandlerTestHarness();

test("dock creation retains human access and sandboxing through discovery and exact reads", async () => {
  const { storePath } = await createSessionStoreDir();
  const profile = ensureProfileForEmail("dock-creator@example.test");
  setUserProfileRole(profile.id, "guest");
  const cfg = {
    ...getRuntimeConfig(),
    session: { ...getRuntimeConfig().session, store: storePath },
    gateway: {
      ...getRuntimeConfig().gateway,
      roles: {
        default: "guest",
        definitions: {
          guest: {
            sessions: { others: "none" as const },
            agents: ["main"],
            scopes: ["operator.read" as const, "operator.write" as const],
            sandbox: "required" as const,
          },
        },
      },
    },
  };
  setRuntimeConfigSnapshot(cfg);
  const client = sharingPolicyClient({ user: profile.id });
  delete client.authenticatedUserId;
  Object.assign(client.connect, { minProtocol: 4, maxProtocol: 4 });
  client.connect.client.platform = "web";
  Object.assign(client.authenticatedUserProfile!, {
    displayName: profile.displayName,
    updatedAt: profile.updatedAt,
  });
  const options = { client, context: { getRuntimeConfig: () => cfg } };
  const request = async (
    method: Parameters<typeof directSessionReq>[0],
    params: Record<string, unknown>,
  ) => {
    const result = await directSessionReq(method, params, options);
    expect(result).toMatchObject({ ok: true });
    return result.payload;
  };
  const creation = {
    createdVia: "operator",
    createdActor: { type: "human", source: "profile", id: profile.id },
    sandbox: "required",
  };
  const normalKey = "agent:main:dashboard:legacy-board";
  const dockKey = "agent:main:dashboard:dock-board";
  await request("sessions.create", { key: normalKey, label: "Board agent" });
  await request("sessions.create", {
    key: dockKey,
    displayName: "Board agent",
    surface: "plugin-dock",
  });
  const scope = { agentId: "main", sessionKey: dockKey, storePath };
  const dock = loadSessionEntry(scope);
  expect(dock).toMatchObject({
    ...creation,
    createdSurface: "plugin-dock",
    displayName: "Board agent",
  });
  expect(await request("sessions.list", { excludeDock: true, involvingMe: true })).toMatchObject({
    sessions: [{ key: normalKey }],
    totalCount: 1,
  });
  expect(await request("sessions.describe", { key: dockKey })).toMatchObject({
    session: {
      key: dockKey,
      isDock: true,
      createdVia: "operator",
      createdSurface: "plugin-dock",
      sharingRole: "owner",
    },
  });
  await request("sessions.get", { key: dockKey });

  // Adoption cannot rewrite either a legacy conversation or a dock's creation stamp.
  for (const [key, createdSurface] of [
    [normalKey, undefined],
    [dockKey, "plugin-dock"],
  ] as const) {
    await request("sessions.create", { key, surface: "plugin-dock" });
    expect(loadSessionEntry({ ...scope, sessionKey: key })).toMatchObject(creation);
    expect(loadSessionEntry({ ...scope, sessionKey: key })?.createdSurface).toBe(createdSurface);
  }
});

test("dock presentation cannot replace a trusted spawn creation contract", async () => {
  await createSessionStoreDir();
  const client = {
    connect: { scopes: ["operator.write"] },
    internal: { sessionCreation: { via: "spawn", actor: { type: "agent", id: "main" } } },
  } as GatewayClient;
  expect(
    await directSessionReq(
      "sessions.create",
      { key: "agent:main:dashboard:spawn", surface: "plugin-dock" },
      { client },
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "INVALID_REQUEST", message: "Dock conversations require operator creation" },
  });
});
