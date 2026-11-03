import { expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
  seedLinearSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each([
  { scope: "per-sender", mainKey: "workspace", home: "agent:main:workspace" },
  { scope: "global", mainKey: "main", home: "global" },
] as const)(
  "restricted people cannot discover or directly read $scope Home, while explicit operator access remains",
  async ({ scope, mainKey, home }) => {
    const { storePath } = await createSessionStoreDir();
    testState.agentsConfig = { entries: { main: {} } };
    testState.sessionConfig = { mainKey, scope };
    const cfg = {
      ...rolePolicyConfig(),
      agents: testState.agentsConfig,
      session: { store: storePath, mainKey, scope },
    };
    cfg.gateway!.roles!.definitions.view!.scopes = [
      "operator.sessions.read",
      "operator.sessions.write",
    ];
    const guest = roleClient("view", "home-guest");
    guest.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
    const ordinary = "agent:main:shared-review";
    await writeSessionStore({
      storePath,
      mainKey,
      entries: {
        [home]: sessionStoreEntry("home-fixture", {
          visibility: "shared",
          label: "Operator Home",
          createdActor: {
            type: "human",
            source: "profile",
            id: guest.authenticatedUserProfile!.profileId,
          },
        }),
        [ordinary]: sessionStoreEntry("review-fixture", {
          visibility: "shared",
          label: "Shared review",
        }),
      },
    });
    await seedLinearSessionTranscript({
      storePath,
      sessionKey: home,
      sessionId: "home-fixture",
      contents: ["Synthetic operator-only Home note."],
    });
    const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
    await initializeSessionReadContext(context);
    const operator = roleClient("write", "home-operator");
    const request = async (
      client: typeof guest,
      method: string,
      params: Record<string, unknown>,
    ) => {
      let response: { ok: boolean; payload: unknown; error: unknown } | undefined;
      await handleGatewayRequest({
        req: { type: "req", id: "home-access", method, params },
        client,
        context,
        isWebchatConnect: () => false,
        respond: (ok, payload, error) => {
          response = { ok, payload, error };
        },
      });
      return response!;
    };
    const listed = await request(guest, "sessions.list", { agentId: "main" });
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed.payload)).toContain(ordinary);
    expect(JSON.stringify(listed.payload)).not.toContain(home);
    for (const [method, params] of [
      ["sessions.resolve", { key: home }],
      ["sessions.describe", { key: home }],
      ["sessions.messages.subscribe", { key: home }],
      ["chat.history", { sessionKey: "main", agentId: "main" }],
      ["sessions.get", { key: home }],
      ["chat.history", { sessionKey: home }],
      ["chat.startup", { sessionKey: home }],
    ] as const) {
      const denied = await request(guest, method, params);
      expect(denied.ok, method).toBe(false);
      expect(JSON.stringify(denied)).not.toContain("Synthetic operator-only");
      expect((await request(operator, method, params)).ok, method).toBe(true);
    }
    expect((await request(guest, "chat.history", { sessionKey: ordinary })).ok).toBe(true);
  },
);

test("a session-only guest cannot create absent Home through its main alias", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentsConfig = { entries: { main: {} } };
  const cfg = {
    ...rolePolicyConfig(),
    agents: testState.agentsConfig,
    session: { store: storePath },
  };
  cfg.gateway!.roles!.definitions.view!.scopes = [
    "operator.sessions.read",
    "operator.sessions.write",
  ];
  const guest = roleClient("view", "home-creator");
  guest.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  await initializeSessionReadContext(context);
  let response: { ok: boolean; error: unknown } | undefined;
  await handleGatewayRequest({
    req: {
      type: "req",
      id: "absent-home",
      method: "sessions.create",
      params: { key: "main", agentId: "main" },
    },
    client: guest,
    context,
    isWebchatConnect: () => false,
    respond: (ok, _payload, error) => {
      response = { ok, error };
    },
  });
  expect(response).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
  expect(
    loadSessionEntry({ storePath, agentId: "main", sessionKey: "agent:main:main" }),
  ).toBeUndefined();
});
