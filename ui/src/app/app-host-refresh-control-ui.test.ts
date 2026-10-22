/* @vitest-environment jsdom */

import { setImmediate as nextTurn } from "node:timers/promises";
import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { createShellOwner } from "./app-host-solid.test-support.ts";
import { subscribeBootRecordChanges } from "./boot-record.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import {
  createGatewayStoreTestStore,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import { loadSettings } from "./settings.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";

vi.hoisted(() => {
  // Build identity is captured on import, including imports from an earlier shared test.
  vi.resetModules();
  vi.stubGlobal("OPENCLAW_CONTROL_UI_BUILD_INFO", {
    version: "1.0.0",
    buildId: "serving-build",
  });
});

function createRefreshShell(gateway: ApplicationRuntime["context"]["gateway"]) {
  const snapshot = { controlUiRefreshRequired: true };
  const shell = createShellOwner();
  shell.runtime = {
    context: { overlays: { snapshot }, gateway },
  } as unknown as ApplicationRuntime;
  return { shell, snapshot };
}

let store: ReturnType<typeof createGatewayStoreTestStore>;
let probe: ReturnType<typeof createDeferred<Response>>;
let replace: ReturnType<typeof vi.fn<(url: string) => void>>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  // Keep automatic retry probes inside this fixture's lifetime.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(Math, "random").mockReturnValue(0);
  stubGatewayStoreTestGlobals();
  replace = vi.fn();
  const location = Object.assign(new URL("http://127.0.0.1:18789/chat/main"), { replace });
  vi.stubGlobal("location", location);
  vi.stubGlobal("window", { location });
  probe = createDeferred<Response>();
  fetchMock = vi.fn<typeof fetch>(() => probe.promise);
  vi.stubGlobal("fetch", fetchMock);
  store = createGatewayStoreTestStore();
  store.gateway.connect({
    bootstrapToken: "synthetic-owner-bootstrap",
    bootstrapProfile: "owner",
  });
});

afterEach(() => {
  store.gateway.stop();
  vi.clearAllTimers();
  vi.useRealTimers();
  setAvatarGatewayOrigin(null);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("retires cached roster admission before publishing a replacement connection", () => {
  store.current().testOptions.onHello?.({
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: [], recoveryScope: "admitted-account" },
  });
  const scope = gatewayCredentialScope(store.gateway.connection.gatewayUrl);
  let retired = false;
  const observed: boolean[] = [];
  const cleanups = [
    subscribeBootRecordChanges((change) => {
      if (change.scope === scope && change.retiredOwner?.recoveryScope === "admitted-account") {
        retired = true;
      }
    }),
    store.gateway.subscribe((snapshot) => {
      if (snapshot.phase === "reconnecting") {
        observed.push(retired);
      }
    }),
  ];
  onTestFinished(() => cleanups.forEach((cleanup) => cleanup()));
  store.gateway.connect({ bootstrapToken: "synthetic-replacement-bootstrap" });
  expect(observed.length).toBeGreaterThan(0);
  expect(observed).not.toContain(false);
});

it.each(["clear", "replace", "remote"])(
  "does not reload for invalid recovery state or a remote target: %s",
  async (action) => {
    if (action === "remote") {
      store.gateway.connect({
        gatewayUrl: "wss://remote-gateway.example",
        bootstrapToken: "synthetic-remote-bootstrap",
      });
    }
    const { shell, snapshot } = createRefreshShell(store.gateway);
    const refresh = shell.refreshControlUi();
    if (action === "clear") {
      snapshot.controlUiRefreshRequired = false;
    } else if (action === "replace") {
      shell.runtime = createRefreshShell(store.gateway).shell.runtime;
    }
    probe.resolve(new Response(null, { status: 200 }));

    await expect(refresh).resolves.toBe(false);
    expect(replace).not.toHaveBeenCalled();
    if (action === "remote") {
      expect(fetchMock).not.toHaveBeenCalled();
    }
  },
);

it("continues the browser handoff when manual refresh follows a failed automatic probe", async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
  store.current().testOptions.onClose?.({
    code: 1008,
    reason: "Control UI updated",
    error: {
      code: "UNAVAILABLE",
      message: "Control UI updated",
      details: {
        code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
        gatewayBuildId: "replacement-build",
        reloadRequired: true,
      },
    },
    willRetry: false,
  });
  await nextTurn();
  expect(replace).not.toHaveBeenCalled();
  const { shell } = createRefreshShell(store.gateway);

  const refresh = shell.refreshControlUi();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  probe.resolve(new Response(null, { status: 200 }));

  await expect(refresh).resolves.toBe(true);
  expect(replace).toHaveBeenCalledOnce();
  const resumed = resolveApplicationStartupSettings(
    loadSettings(),
    new URL(replace.mock.calls[0]![0]),
  );
  expect(resumed.pendingBootstrapToken).toBe("synthetic-owner-bootstrap");
  expect(resumed.pendingBootstrapProfile).toBe("owner");
  expect(resumed.location.hash).toBe("");

  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(replace).toHaveBeenCalledOnce();
});
