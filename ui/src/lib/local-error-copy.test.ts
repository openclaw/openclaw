// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { formatBrowserWebSocketConstructorError } from "../api/gateway-browser-socket.ts";
import { createNativeGatewayConnectAuth } from "../app/native-gateway-auth.ts";
import { subscribeToWebPush } from "../app/web-push.runtime.ts";
import { i18n } from "../i18n/lib/translate.ts";
import { formatMissingOperatorReadScopeMessage } from "./gateway-errors.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("localizes permission copy and its feature label", async () => {
  const translate = vi
    .spyOn(i18n, "t")
    .mockImplementation((key) =>
      key === "runtimeErrors.permissionFeatures.logs"
        ? "localized feature"
        : "localized permission",
    );
  expect(await formatMissingOperatorReadScopeMessage("logs", "Gateway denial")).toBe(
    "localized permission",
  );
  expect(translate).toHaveBeenCalledWith("runtimeErrors.permissionDenied", {
    feature: "localized feature",
  });
});

it("localizes browser connection failures while retaining browser diagnostics", () => {
  const translate = vi.spyOn(i18n, "t").mockReturnValue("localized browser failure");
  const error = formatBrowserWebSocketConstructorError(
    new Error("external browser detail"),
    "ws://localhost:18789",
  );
  expect(error.message).toBe("localized browser failure");
  expect(translate).toHaveBeenCalledWith("runtimeErrors.socketCreateFailed", {
    message: "external browser detail",
  });
  expect(error.details).toMatchObject({ browserMessage: "external browser detail" });
});

it("localizes native authentication failures", async () => {
  const translate = vi.spyOn(i18n, "t").mockReturnValue("localized native failure");
  const auth = createNativeGatewayConnectAuth("ws://localhost:18789");
  await expect(
    auth({
      gatewayUrl: "ws://localhost:18789",
      nonce: "test",
      signedAt: Date.now(),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow("localized native failure");
  expect(translate).toHaveBeenCalledWith("runtimeErrors.nativeUnavailable", undefined);
});

it("localizes notification permission failures without translating the protocol status", async () => {
  const translate = vi.spyOn(i18n, "t").mockReturnValue("localized notification failure");
  vi.stubGlobal("Notification", { requestPermission: vi.fn().mockResolvedValue("denied") });
  await expect(subscribeToWebPush({ request: vi.fn() }, () => {})).rejects.toThrow(
    "localized notification failure",
  );
  expect(translate).toHaveBeenCalledWith("notificationErrors.permission", { permission: "denied" });
});
