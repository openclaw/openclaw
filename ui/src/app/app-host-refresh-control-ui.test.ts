/* @vitest-environment jsdom */

import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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

it.each(["clear", "replace"])(
  "does not reload after the shell's recovery state is %s",
  async (action) => {
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
  },
);

it("carries the browser handoff through a manual shell refresh", async () => {
  const { shell } = createRefreshShell(store.gateway);

  const refresh = shell.refreshControlUi();
  probe.resolve(new Response(null, { status: 200 }));

  await expect(refresh).resolves.toBe(true);
  expect(replace).toHaveBeenCalledOnce();
  const resumed = resolveApplicationStartupSettings(
    loadSettings(),
    new URL(replace.mock.calls[0]![0]),
  );
  expect(resumed).toMatchObject({
    pendingBootstrapToken: "synthetic-owner-bootstrap",
    pendingBootstrapProfile: "owner",
    location: { hash: "" },
  });
});
