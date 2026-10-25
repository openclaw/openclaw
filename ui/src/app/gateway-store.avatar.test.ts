// @vitest-environment node
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { GatewayHelloOk } from "../api/gateway.ts";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { resolveAvatarImageUrl } from "../lib/identity-avatar-loader.ts";
import { resolveBootRecordAuth } from "./boot-record.ts";
import { makeBootRecord } from "./bootstrap.test-support.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import { loadSettings } from "./settings.ts";

describe("Gateway-owned avatar continuity", () => {
  let store: ReturnType<typeof createGatewayStoreTestStore>;
  const avatar = "/api/users/fixture-person/avatar?v=revision-1";
  beforeEach(() => {
    vi.useFakeTimers();
    stubGatewayStoreTestGlobals();
    const settings = { ...loadSettings(), token: "synthetic-shared-token" };
    const scope = gatewayCredentialScope(settings.gatewayUrl);
    localStorage.setItem(
      `openclaw.control.bootRecord.v1:${scope}`,
      JSON.stringify(
        makeBootRecord(scope, {
          ...resolveBootRecordAuth({ method: "token" }, settings.token)!,
          profileId: "fixture-person",
          recoveryScope: "fixture-recovery",
        }),
      ),
    );
    store = createGatewayStoreTestStore({ settings });
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:loaded-avatar");
    vi.spyOn(URL, "revokeObjectURL");
    store.gateway.start();
  });
  afterEach(() => {
    store.gateway.stop();
    setAvatarGatewayOrigin(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const hello = (
    profileId = "fixture-person",
    recoveryScope = "fixture-recovery",
    deviceToken = "synthetic-issued-device-token",
  ) => {
    const value: GatewayHelloOk = {
      ...GATEWAY_STORE_TEST_HELLO,
      auth: {
        role: "operator",
        scopes: ["operator.read"],
        method: "token",
        deviceToken,
        recoveryScope,
      },
      snapshot: {
        presence: [{ ts: 1, instanceId: store.current().instanceId, user: { id: profileId } }],
      },
    };
    store.current().testOptions.onHello?.(value);
  };
  const loadAvatar = async () => {
    const pending = resolveAvatarImageUrl(avatar);
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBe("blob:loaded-avatar");
  };

  it("keeps a loaded image when hello promotes credentials for the admitted same scope", async () => {
    await loadAvatar();
    hello();
    expect(store.gateway.snapshot.selfUser?.id).toBe("fixture-person");
    expect(resolveAvatarImageUrl(avatar)).toBe("blob:loaded-avatar");
    expect(fetch).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    const response = createDeferred<Response>();
    vi.mocked(fetch).mockReturnValueOnce(response.promise);
    const pending = resolveAvatarImageUrl("/avatar/pending?v=1");
    await vi.advanceTimersByTimeAsync(0);
    hello("fixture-person", "fixture-recovery", "synthetic-rotated-device-token");
    response.resolve(new Response(null, { status: 401 }));
    await expect(pending).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(resolveAvatarImageUrl(avatar)).toBe("blob:loaded-avatar");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.mocked(URL.createObjectURL).mockReturnValueOnce("blob:replacement-request");
    const retried = resolveAvatarImageUrl("/avatar/pending?v=1");
    await vi.advanceTimersByTimeAsync(0);
    expect(await retried).toBe("blob:replacement-request");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    "profile",
    "recovery scope",
    "gateway",
    "credential subject",
    "logout",
    "revocation",
    "operator access revocation",
    "live profile",
  ])("retires a loaded image on %s change", async (change) => {
    hello();
    await loadAvatar();
    if (change === "profile") hello("another-person");
    if (change === "recovery scope") hello("fixture-person", "another-recovery");
    if (change === "gateway") store.gateway.connect({ gatewayUrl: "ws://127.0.0.1:18789/other" });
    if (change === "credential subject")
      store.gateway.connect({ token: "synthetic-other-subject" });
    if (change === "logout") store.gateway.stop();
    if (change === "revocation") {
      store.current().testOptions.onClose?.({
        code: 1008,
        reason: "synthetic revocation",
        willRetry: false,
        error: { code: "PAIRING_REQUIRED", message: "synthetic revocation" },
      });
    }
    if (change === "operator access revocation") {
      store.current().testOptions.onClose?.({
        code: 4001,
        reason: "Operator access denied",
        willRetry: true,
      });
    }
    if (change === "live profile") {
      store.current().testOptions.onEvent?.(
        createGatewayEvent("presence", {
          reset: true,
          version: 1,
          keys: ["self"],
          presence: [
            { ts: 2, instanceId: store.current().instanceId, user: { id: "another-person" } },
          ],
        }),
      );
    }
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:loaded-avatar");
  });
});
