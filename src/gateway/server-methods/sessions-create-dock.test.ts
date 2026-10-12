import { expect, test } from "vitest";
import { getRuntimeConfig } from "../../config/io.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { setupSessionCreateHandlerTestHarness } from "../server.sessions.create.test-support.js";
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
  const client: GatewayClient = {
    connect: {
      minProtocol: 4,
      maxProtocol: 4,
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
    },
    authenticatedUserProfile: {
      profileId: profile.id,
      displayName: profile.displayName,
      hasAvatar: false,
      updatedAt: profile.updatedAt,
    },
  };
  const options = { client, context: { getRuntimeConfig: () => cfg } };
  const normalKey = "agent:main:dashboard:legacy-board";
  const dockKey = "agent:main:dashboard:dock-board";
  expect(
    await directSessionReq("sessions.create", { key: normalKey, label: "Board agent" }, options),
  ).toMatchObject({ ok: true });
  expect(
    await directSessionReq(
      "sessions.create",
      { key: dockKey, displayName: "Board agent", surface: "plugin-dock" },
      options,
    ),
  ).toMatchObject({ ok: true });
  const scope = { agentId: "main", sessionKey: dockKey, storePath };
  const dock = loadSessionEntry(scope);
  expect(dock).toMatchObject({
    createdVia: "operator",
    createdSurface: "plugin-dock",
    createdActor: { type: "human", source: "profile", id: profile.id },
    sandbox: "required",
    displayName: "Board agent",
  });
  expect(
    await directSessionReq("sessions.list", { excludeDock: true, involvingMe: true }, options),
  ).toMatchObject({ ok: true, payload: { sessions: [{ key: normalKey }], totalCount: 1 } });
  expect(await directSessionReq("sessions.describe", { key: dockKey }, options)).toMatchObject({
    ok: true,
    payload: {
      session: {
        key: dockKey,
        isDock: true,
        createdVia: "operator",
        createdSurface: "plugin-dock",
        sharingRole: "owner",
      },
    },
  });
  expect(await directSessionReq("sessions.get", { key: dockKey }, options)).toMatchObject({
    ok: true,
  });

  // Adoption cannot rewrite either a legacy conversation or a dock's creation stamp.
  for (const [key, createdSurface] of [
    [normalKey, undefined],
    [dockKey, "plugin-dock"],
  ] as const) {
    expect(
      await directSessionReq("sessions.create", { key, surface: "plugin-dock" }, options),
    ).toMatchObject({ ok: true });
    expect(loadSessionEntry({ ...scope, sessionKey: key })).toMatchObject({
      createdVia: "operator",
      createdActor: { type: "human", source: "profile", id: profile.id },
      sandbox: "required",
    });
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
