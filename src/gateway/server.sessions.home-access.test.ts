import { expect, test } from "vitest";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
  seedLinearSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test("restricted people cannot discover or directly read operator Home, while explicit operator access remains", async () => {
  const { storePath } = await createSessionStoreDir();
  const cfg = { ...rolePolicyConfig(), session: { store: storePath, mainKey: "workspace" } };
  cfg.gateway!.roles!.definitions.view!.scopes = [
    "operator.sessions.read",
    "operator.sessions.write",
  ];
  const guest = roleClient("view", "home-guest");
  guest.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
  const operator = roleClient("write", "home-operator");
  const home = "agent:main:workspace";
  const ordinary = "agent:main:shared-review";
  await writeSessionStore({
    entries: {
      [home]: sessionStoreEntry("home-fixture", { visibility: "shared", label: "Operator Home" }),
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
  const request = async (client: typeof guest, method: string, params: Record<string, unknown>) => {
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
});
