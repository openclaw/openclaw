import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { sendApnsAlert } from "../../infra/push-apns.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createTestProjection } from "../session-row-projection.read-fixture.test-support.js";
import { pushHandlers } from "./push.js";

// mock-isolation: replace external APNs credentials/delivery only; session preparation is real.
vi.mock("../../infra/push-apns.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/push-apns.js")>()),
  loadApnsRegistration: vi.fn(async () => ({
    nodeId: "fixture-node",
    transport: "direct",
    token: "fixture-token",
    topic: "fixture.topic",
    environment: "sandbox",
    updatedAtMs: 1,
  })),
  resolveApnsAuthConfigFromEnv: vi.fn(async () => ({ ok: true, value: {} })),
  sendApnsAlert: vi.fn(async () => ({ ok: true, status: 200 })),
}));
// mock-isolation: bind the synthetic sending Gateway without reading its host identity.
vi.mock("../../infra/device-identity-async.js", () => ({
  loadOrCreateProcessDeviceIdentityAsync: async () => ({ deviceId: "fixture-gateway" }),
}));
afterEach(() => vi.clearAllMocks());

it("delivers a destination push after the real synchronous prepared-read owner returns", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = { agents: { ownership: "explicit" as const, entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const key = "agent:main:notification-destination";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      {
        sessionId: "notification-destination",
        updatedAt: 1,
      },
    );
    using projection = await createTestProjection({ cfg });
    const context = bindSessionRowProjection(
      createDirectChatContext({ getRuntimeConfig: () => cfg }),
      () => projection,
    );
    const respond = vi.fn();
    await pushHandlers["push.test"]({
      params: { nodeId: "fixture-node", sessionKey: key },
      respond,
      context,
      client: null,
      req: { type: "req", id: "destination", method: "push.test" },
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, { ok: true, status: 200 }, undefined);
    expect(sendApnsAlert).toHaveBeenCalledTimes(1);
    const alert = vi.mocked(sendApnsAlert).mock.calls[0]![0];
    expect(alert.destination).toEqual({ gatewayDeviceId: "fixture-gateway", sessionKey: key });
    expect(await alert.isCurrent?.()).toBe(true);
  });
});
