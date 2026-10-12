/* @vitest-environment jsdom */

import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "../lib/identity-avatar-context.ts";
import { subscribeBootRecordChanges } from "./boot-record.ts";
import type { ApplicationRuntime } from "./bootstrap.ts";
import {
  createGatewayStoreTestStore,
  stubGatewayStoreTestGlobals,
} from "./gateway-store.test-support.ts";
import { loadSettings } from "./settings.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";
import "./app-host.ts";

vi.hoisted(() => {
  // Build identity is captured on import, including imports from an earlier shared test.
  vi.resetModules();
  vi.stubGlobal("OPENCLAW_CONTROL_UI_BUILD_INFO", {
    version: "1.0.0",
    buildId: "serving-build",
    commit: null,
    commitAt: null,
    builtAt: null,
    branch: null,
    dirty: null,
    release: false,
  });
});

type RefreshShell = HTMLElement & {
  runtime: ApplicationRuntime;
  refreshControlUi: () => Promise<boolean>;
};

function createRefreshShell(gateway: ApplicationRuntime["context"]["gateway"]) {
  const snapshot = { controlUiRefreshRequired: true };
  const shell = document.createElement("openclaw-app-shell") as RefreshShell;
  shell.runtime = {
    context: { overlays: { snapshot }, gateway },
  } as unknown as ApplicationRuntime;
  return { shell, snapshot };
}

describe("OpenClaw shell Control UI refresh", () => {
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
    store.current().opts.onHello?.({
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: [], recoveryScope: "admitted-account" },
    });
    const scope = gatewayCredentialScope(store.gateway.connection.gatewayUrl);
    const retiredOwners: string[] = [];
    const unsubscribeRetirement = subscribeBootRecordChanges((change) => {
      if (change.scope === scope && change.retiredOwner?.recoveryScope) {
        retiredOwners.push(change.retiredOwner.recoveryScope);
      }
    });
    const observed: string[][] = [];
    const unsubscribe = store.gateway.subscribe((snapshot) => {
      if (snapshot.phase === "reconnecting") {
        observed.push([...retiredOwners]);
      }
    });
    try {
      store.gateway.connect({ bootstrapToken: "synthetic-replacement-bootstrap" });
      expect(observed.length).toBeGreaterThan(0);
      for (const current of observed) {
        expect(current).toContain("admitted-account");
      }
    } finally {
      unsubscribe();
      unsubscribeRetirement();
    }
  });

  it.each(["clear", "replace"])(
    "does not reload after the shell recovery state changes: %s",
    async (action) => {
      const { shell, snapshot } = createRefreshShell(store.gateway);
      const refresh = shell.refreshControlUi();
      if (action === "clear") {
        snapshot.controlUiRefreshRequired = false;
      } else {
        shell.runtime = createRefreshShell(store.gateway).shell.runtime;
      }
      probe.resolve(new Response(null, { status: 200 }));

      await expect(refresh).resolves.toBe(false);
      expect(replace).not.toHaveBeenCalled();
    },
  );

  it("continues the browser handoff when manual refresh follows a failed automatic probe", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    store.current().opts.onClose?.({
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
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
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
  });

  it("keeps a pending remote handoff out of the serving document on manual Refresh", async () => {
    store.gateway.connect({
      gatewayUrl: "wss://remote-gateway.example",
      bootstrapToken: "synthetic-remote-bootstrap",
    });
    const { shell } = createRefreshShell(store.gateway);
    const refresh = shell.refreshControlUi();
    probe.resolve(new Response(null, { status: 200 }));

    await expect(refresh).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
