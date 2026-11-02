// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { sendSessionObserverVisibility } from "./chat-observer.ts";

describe("chat observer visibility rpc", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { visible: false, preference: "pill", sent: false },
    { visible: undefined, preference: "off", sent: false },
    { visible: undefined, preference: "pill", sent: true },
  ])(
    "sends visibility $sent with explicit=$visible and preference=$preference",
    async ({ visible, preference, sent }) => {
      const request = vi.fn(async () => ({ ok: true as const }));
      const storage = createStorageMock();
      storage.setItem("openclaw.chat.observerHud.display", preference);
      vi.stubGlobal("localStorage", storage);

      await expect(
        sendSessionObserverVisibility(
          {
            client: { request } as unknown as GatewayBrowserClient,
            phase: "connected",
            hello: gatewayHelloForMethods(["sessions.observer.visibility"]),
          },
          visible,
        ),
      ).resolves.toEqual({ ok: true });
      expect(request).toHaveBeenCalledWith("sessions.observer.visibility", { visible: sent });
    },
  );

  it.each([
    { scopes: [] },
    { scopes: ["operator.sessions.read"] },
    { scopes: ["operator.sessions.write"] },
  ])("does not publish visibility with limited scopes $scopes", async ({ scopes }) => {
    const request = vi.fn();
    const snapshot = {
      client: { request } as unknown as GatewayBrowserClient,
      phase: "connected" as const,
      hello: gatewayHelloForMethods(["sessions.observer.visibility"], scopes),
    };
    await sendSessionObserverVisibility(snapshot, true);
    await sendSessionObserverVisibility(snapshot, false);
    expect(request).not.toHaveBeenCalled();
  });
});
