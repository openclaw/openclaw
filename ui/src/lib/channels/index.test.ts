import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventListener } from "../../api/gateway.ts";
import type { ChannelsPairingListResult, ChannelsStatusSnapshot } from "../../api/types.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import {
  channelSnapshotEntryIsActive,
  channelSnapshotHasActiveChannel,
  createChannelCapability,
} from "./index.ts";

type GatewaySnapshot = Parameters<typeof createChannelCapability>[0]["snapshot"];
type LoginResult = { message: string; connected: boolean; qrDataUrl: string };
function loginResult(label: string, connected = false): LoginResult {
  return { message: `${label} login`, connected, qrDataUrl: `data:image/png;base64,${label}-qr` };
}
const capabilities: ReturnType<typeof createChannelCapability>[] = [];
afterEach(() => {
  for (const channels of capabilities.splice(0)) {
    channels.dispose();
  }
});

function createHarness(
  request: GatewayRequestHandler,
  scopes?: string[],
  client: GatewaySnapshot["client"] = createTestGatewayClient(request),
) {
  let snapshot: GatewaySnapshot = {
    client,
    phase: "connected",
    hello: { auth: { role: "operator", scopes } },
  };
  const listeners = new Set<(next: GatewaySnapshot) => void>();
  const eventListeners = new Set<GatewayEventListener>();
  const channels = createChannelCapability({
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeEvents(listener: GatewayEventListener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  });
  capabilities.push(channels);
  const update = (patch: Partial<GatewaySnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };
  return {
    channels,
    update,
    setScopes: (nextScopes: string[]) =>
      update({ hello: { auth: { role: "operator", scopes: nextScopes } } }),
    emitEvent: (event: string) => {
      for (const listener of eventListeners) {
        listener({ type: "event", event, payload: {} });
      }
    },
  };
}

function createChannelsSnapshot(label: string): ChannelsStatusSnapshot {
  return {
    ts: Date.now(),
    channelOrder: ["test"],
    channelLabels: { test: label },
    channels: {},
    channelAccounts: {},
    channelDefaultAccountId: {},
  };
}

function createStaticChannelCapability(request: GatewayRequestHandler) {
  return createHarness(request).channels;
}

describe("channel readiness", () => {
  it("treats aggregate or account configuration as active", () => {
    const snapshot = createChannelsSnapshot("Test");
    snapshot.channelOrder = ["configured", "connected", "empty"];
    snapshot.channels = {
      configured: { configured: true },
      connected: { configured: false, connected: false },
      empty: { configured: false, running: false, connected: false },
    };
    snapshot.channelAccounts = {
      connected: [{ accountId: "work", connected: true }],
      empty: [],
    };

    expect(channelSnapshotEntryIsActive(snapshot, "configured")).toBe(true);
    expect(channelSnapshotEntryIsActive(snapshot, "connected")).toBe(true);
    expect(channelSnapshotEntryIsActive(snapshot, "empty")).toBe(false);
    expect(channelSnapshotHasActiveChannel(snapshot)).toBe(true);
  });

  it("recognizes active channels omitted from channelOrder", () => {
    const snapshot = createChannelsSnapshot("Test");
    snapshot.channelOrder = [];
    snapshot.channels = {};
    snapshot.channelAccounts = {
      telegram: [{ accountId: "default", running: true }],
    };

    expect(channelSnapshotHasActiveChannel(snapshot)).toBe(true);
    expect(channelSnapshotHasActiveChannel(null)).toBe(false);
  });
});

describe("channels controller WhatsApp wait", () => {
  it("rejects a stale login result after reconnecting with the same client", async () => {
    const staleWait = createDeferred<LoginResult>();
    const freshWait = createDeferred<LoginResult>();
    let waitCount = 0;
    const request = vi.fn((method: string) => {
      if (method === "web.login.wait") {
        waitCount += 1;
        return waitCount === 1 ? staleWait.promise : freshWait.promise;
      }
      return Promise.resolve(createChannelsSnapshot("fresh"));
    });
    const { channels, update } = createHarness(request);

    const stale = channels.waitWhatsApp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    update({ phase: "reconnecting" });
    update({ phase: "connected" });

    const fresh = channels.waitWhatsApp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    freshWait.resolve(loginResult("fresh"));
    await fresh;

    staleWait.resolve(loginResult("stale", true));
    await stale;

    expect(channels.state.whatsappLoginMessage).toBe("fresh login");
    expect(channels.state.whatsappLoginQrDataUrl).toBe("data:image/png;base64,fresh-qr");
    expect(request.mock.calls.filter(([method]) => method === "channels.status")).toHaveLength(1);
  });

  it("keeps an active login wait across pairing-scope changes", async () => {
    const pending = createDeferred<LoginResult>();
    const request = vi.fn((method: string) =>
      method === "web.login.wait"
        ? pending.promise
        : Promise.resolve(createChannelsSnapshot("refreshed")),
    );
    const { channels, setScopes } = createHarness(request, ["operator.pairing"]);

    const wait = channels.waitWhatsApp();
    await vi.waitFor(() => expect(channels.state.whatsappBusy).toBe(true));
    setScopes(["operator.pairing", "operator.read"]);
    expect(channels.state.whatsappBusy).toBe(true);

    pending.resolve({
      message: "login survived scope change",
      connected: false,
      qrDataUrl: "data:image/png;base64,scope-change",
    });
    await wait;

    expect(channels.state.whatsappLoginMessage).toBe("login survived scope change");
    expect(channels.state.whatsappLoginQrDataUrl).toBe("data:image/png;base64,scope-change");
  });

  it("rejects an active login result when admin access is revoked", async () => {
    const pending = createDeferred<LoginResult>();
    const request = vi.fn(() => pending.promise);
    const { channels, setScopes } = createHarness(request, ["operator.admin", "operator.pairing"]);
    channels.state.whatsappLoginQrDataUrl = "data:image/png;base64,existing";
    channels.state.whatsappLoginSessionKey = "existing-session";

    const wait = channels.waitWhatsApp();
    await vi.waitFor(() => expect(channels.state.whatsappBusy).toBe(true));
    setScopes(["operator.pairing"]);
    expect(channels.state.whatsappBusy).toBe(false);
    expect(channels.state.whatsappLoginQrDataUrl).toBeNull();
    expect(channels.state.whatsappLoginSessionKey).toBeNull();

    pending.resolve(loginResult("stale", true));
    await wait;

    expect(channels.state.whatsappLoginMessage).toBeNull();
    expect(channels.state.whatsappLoginQrDataUrl).toBeNull();
  });

  it("does not apply or refresh a login result after its capability is disposed", async () => {
    const pending = createDeferred<LoginResult>();
    const request = vi.fn(() => pending.promise);
    const channels = createStaticChannelCapability(request);

    const wait = channels.waitWhatsApp();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    channels.dispose();
    pending.resolve(loginResult("stale", true));
    await wait;

    expect(channels.state.whatsappLoginMessage).toBeNull();
    expect(channels.state.whatsappLoginQrDataUrl).toBeNull();
    expect(request).toHaveBeenCalledOnce();

    await channels.waitWhatsApp();
    expect(request).toHaveBeenCalledOnce();
  });
});

describe("channels controller WhatsApp provider selection", () => {
  it("carries the provider session key from login start into wait", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "web.login.start") {
        return { message: "scan", sessionKey: "opaque-session" };
      }
      if (method === "web.login.wait") {
        return { connected: true, message: "connected" };
      }
      return createChannelsSnapshot("refreshed");
    });
    const channels = createStaticChannelCapability(request);

    await channels.startWhatsApp(false);
    await channels.waitWhatsApp();

    expect(request).toHaveBeenCalledWith(
      "web.login.start",
      expect.objectContaining({ channel: "whatsapp" }),
    );
    expect(request).toHaveBeenCalledWith(
      "web.login.wait",
      expect.objectContaining({ channel: "whatsapp", sessionKey: "opaque-session" }),
    );
    expect(channels.state.whatsappLoginSessionKey).toBeNull();
  });
});

describe("channels controller WhatsApp logout", () => {
  it.each([false, true])(
    "clears login state only with confirmed clearance: %s",
    async (cleared) => {
      const request = vi.fn(async (method: string) =>
        method === "channels.logout"
          ? { cleared, loggedOut: cleared }
          : createChannelsSnapshot("refreshed"),
      );
      const channels = createStaticChannelCapability(request);
      channels.state.whatsappLoginMessage = "Scan this QR.";
      channels.state.whatsappLoginQrDataUrl = "data:image/png;base64,current-qr";
      channels.state.whatsappLoginConnected = true;

      const accountId = cleared ? undefined : "work";
      await channels.logoutWhatsApp(accountId);

      expect(request).toHaveBeenCalledWith("channels.logout", {
        channel: "whatsapp",
        ...(accountId ? { accountId } : {}),
      });
      expect(request.mock.calls.filter(([method]) => method === "channels.status")).toHaveLength(1);
      expect(channels.state).toMatchObject({
        whatsappLoginMessage: cleared
          ? "Logged out."
          : "No stored WhatsApp session was cleared. It may already be absent, or its auth directory may require manual cleanup.",
        whatsappLoginQrDataUrl: cleared ? null : "data:image/png;base64,current-qr",
        whatsappLoginConnected: cleared ? null : true,
        whatsappBusy: false,
      });
    },
  );
});

describe("channels controller WhatsApp mutation failures", () => {
  it.each(["web.login.start", "web.login.wait"])(
    "publishes rejected %s without probing status",
    async (method) => {
      const request = vi.fn(async (requestedMethod: string) => {
        if (requestedMethod === method) {
          throw new Error("WhatsApp request rejected");
        }
        return createChannelsSnapshot("unexpected refresh");
      });
      const channels = createStaticChannelCapability(request);
      channels.state.whatsappLoginQrDataUrl = "data:image/png;base64,current-qr";
      channels.state.whatsappLoginConnected = true;
      const updates: Array<{ busy: boolean; message: string | null }> = [];
      channels.subscribe((state) => {
        updates.push({ busy: state.whatsappBusy, message: state.whatsappLoginMessage });
      });

      await (method === "web.login.start"
        ? channels.startWhatsApp(false)
        : channels.waitWhatsApp());

      expect(
        request.mock.calls.filter(([requestedMethod]) => requestedMethod === "channels.status"),
      ).toHaveLength(0);
      expect(updates.at(-1)).toEqual({ busy: false, message: "WhatsApp request rejected" });
      expect(channels.state.whatsappLoginQrDataUrl).toBe(
        method === "web.login.wait" ? "data:image/png;base64,current-qr" : null,
      );
      expect(channels.state.whatsappLoginConnected).toBeNull();
    },
  );
});

describe("channels controller DM pairing", () => {
  const pairingTarget = { channel: "whatsapp", accountId: "personal", requestId: "request-1" };
  const approvalParams = { ...pairingTarget, notify: false, bootstrapCommandOwner: false };
  const approved = {
    requestId: "request-1",
    senderId: "+1555",
    notification: "not-requested" as const,
    commandOwnerBootstrap: "not-requested" as const,
  };
  const emptyPairing: ChannelsPairingListResult = {
    accounts: [],
    requests: [],
    commandOwnerConfigured: true,
    limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
  };
  const pendingPairing: ChannelsPairingListResult = {
    ...emptyPairing,
    accounts: [
      {
        channel: "whatsapp",
        channelLabel: "WhatsApp",
        accountId: "personal",
        notifySupported: true,
      },
    ],
    requests: [
      {
        ...pairingTarget,
        channelLabel: "WhatsApp",
        senderId: "+1555",
        senderLabel: "Phone number",
        createdAt: "2026-07-20T10:00:00.000Z",
        lastSeenAt: "2026-07-20T10:00:00.000Z",
        expiresAt: "2026-07-20T11:00:00.000Z",
        notifySupported: true,
      },
    ],
  };

  it("loads pending requests and refreshes after dismissal", async () => {
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "channels.pairing.list") {
        listCount += 1;
        return listCount === 1 ? pendingPairing : emptyPairing;
      }
      return {};
    });
    const channels = createStaticChannelCapability(request);

    await channels.refreshPairing();
    expect(channels.state.pairingSnapshot?.requests).toHaveLength(1);

    await expect(channels.dismissPairing(pairingTarget)).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("channels.pairing.dismiss", pairingTarget);
    expect(channels.state.pairingSnapshot?.requests).toEqual([]);
    expect(channels.state.pairingBusyRequestId).toBeNull();
  });

  it("keeps the row resolved when refresh fails and blocks polling during mutation", async () => {
    const approvalResult = createDeferred<typeof approved>();
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "channels.pairing.list") {
        listCount += 1;
        if (listCount === 1) {
          return pendingPairing;
        }
        throw new Error("refresh unavailable");
      }
      return approvalResult.promise;
    });
    const channels = createStaticChannelCapability(request);
    await channels.refreshPairing();

    const approval = channels.approvePairing(approvalParams);
    await vi.waitFor(() => expect(channels.state.pairingBusyRequestId).toBe("request-1"));
    await channels.refreshPairing();
    expect(listCount).toBe(1);

    approvalResult.resolve(approved);
    await approval;

    expect(channels.state.pairingSnapshot?.requests).toEqual([]);
    await expect(channels.state.pairingRead?.completion).resolves.toBe("refresh unavailable");
    expect(channels.state.pairingError).toBeNull();
  });

  it("does not let a pre-approval list restore the resolved request", async () => {
    const staleList = createDeferred<ChannelsPairingListResult>();
    const freshList = createDeferred<ChannelsPairingListResult>();
    let listCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "channels.pairing.list") {
        listCount += 1;
        return listCount === 1 ? staleList.promise : freshList.promise;
      }
      return approved;
    });
    const channels = createStaticChannelCapability(request);

    const staleRefresh = channels.refreshPairing();
    const staleReceipt = channels.state.pairingRead!;
    await channels.refreshPairing();
    expect(channels.state.pairingRead).toBe(staleReceipt);
    expect(listCount).toBe(1);
    const approval = channels.approvePairing(approvalParams);
    await expect(staleReceipt.completion).resolves.toBeNull();
    await vi.waitFor(() => expect(listCount).toBe(2));
    expect(channels.state.pairingRead).not.toBe(staleReceipt);
    freshList.resolve(emptyPairing);
    await approval;

    staleList.resolve(pendingPairing);
    await staleRefresh;

    expect(channels.state.pairingSnapshot?.requests).toEqual([]);
  });

  it.each(["disconnect", "authorization", "dispose"] as const)(
    "settles a retired pairing read before its transport responds after %s",
    async (change) => {
      const pending = createDeferred<ChannelsPairingListResult>();
      const request = vi.fn().mockReturnValue(pending.promise);
      const { channels, update, setScopes } = createHarness(request, ["operator.pairing"]);
      const refresh = channels.refreshPairing();
      const receipt = channels.state.pairingRead!;
      let settled = false;
      void receipt.completion.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      if (change === "disconnect") {
        update({ phase: "reconnecting" });
      } else if (change === "authorization") {
        setScopes([]);
      } else {
        channels.dispose();
      }
      await expect(receipt.completion).resolves.toBeNull();
      expect(channels.state.pairingLoading).toBe(false);
      pending.resolve(pendingPairing);
      await refresh;
      expect(channels.state.pairingSnapshot).toBeNull();
    },
  );

  it("retains sender metadata on disconnect and clears it on pairing-scope changes", () => {
    const { channels, update, setScopes } = createHarness(vi.fn(), ["operator.pairing"]);
    channels.state.pairingSnapshot = pendingPairing;

    update({ phase: "reconnecting" });
    expect(channels.state.pairingSnapshot).toBe(pendingPairing);

    update({ phase: "connected" });
    setScopes(["operator.read"]);
    expect(channels.state.pairingSnapshot).toBeNull();

    channels.state.pairingSnapshot = pendingPairing;
    update({ client: createTestGatewayClient(vi.fn()) });
    expect(channels.state.pairingSnapshot).toBeNull();
  });

  it("ignores a pairing mutation result from an earlier authorization epoch", async () => {
    const approval = createDeferred<typeof approved>();
    const request = vi.fn(async (method: string) => {
      if (method === "channels.pairing.approve") {
        return approval.promise;
      }
      return emptyPairing;
    });
    const { channels, setScopes } = createHarness(request, ["operator.pairing"]);
    channels.state.pairingSnapshot = pendingPairing;

    const pendingApproval = channels.approvePairing(approvalParams);
    await vi.waitFor(() => expect(channels.state.pairingBusyRequestId).toBe("request-1"));
    setScopes(["operator.pairing", "operator.read"]);
    channels.state.pairingSnapshot = pendingPairing;

    approval.resolve(approved);

    await expect(pendingApproval).resolves.toBeNull();
    expect(channels.state.pairingSnapshot).toBe(pendingPairing);
    expect(request.mock.calls.filter(([method]) => method === "channels.pairing.list")).toEqual([]);
  });
});

describe("channel refresh sequencing", () => {
  it.each(["pending", "settling"] as const)(
    "coalesces config changes ahead of a probe while the status read is %s",
    async (probeTiming) => {
      const pending = createDeferred<ChannelsStatusSnapshot>();
      const slowProbe = createDeferred<ChannelsStatusSnapshot>();
      const configured = createChannelsSnapshot("configured");
      const request = vi
        .fn()
        .mockImplementation((_method: string, params: { probe: boolean }) =>
          params.probe ? slowProbe.promise : Promise.resolve(configured),
        )
        .mockReturnValueOnce(pending.promise);
      // Keep the raw transport promise: the settling case depends on its microtask order.
      const { channels, emitEvent } = createHarness(request, undefined, { request });
      const refresh = channels.refresh();
      const initialRead = channels.state.channelsRead!;

      emitEvent("config.changed");
      emitEvent("config.changed");
      emitEvent("config.changed");
      expect(request).toHaveBeenCalledOnce();
      const probe =
        probeTiming === "pending"
          ? channels.refresh(true)
          : pending.promise.then(() => channels.refresh(true));
      expect(channels.state.channelsRead).toBe(initialRead);
      try {
        pending.resolve(createChannelsSnapshot("before save"));
        await refresh;

        expect(channels.state.channelsSnapshot).toBe(configured);
        expect(channels.state.channelsLoading).toBe(false);
        expect(channels.state.channelsRead).not.toBe(initialRead);
        await expect(initialRead.completion).resolves.toBeNull();
        await expect(channels.state.channelsRead!.completion).resolves.toBeNull();
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenLastCalledWith("channels.status", {
          probe: false,
          timeoutMs: 8000,
        });
      } finally {
        slowProbe.resolve(createChannelsSnapshot("probe"));
        await probe;
      }
    },
  );

  it.each(["reconnect", "read access", "dispose"] as const)(
    "retires a pending config refresh after %s changes",
    async (transition) => {
      const pending = createDeferred<ChannelsStatusSnapshot>();
      const request = vi.fn().mockReturnValue(pending.promise);
      const { channels, update, setScopes, emitEvent } = createHarness(request, ["operator.read"]);
      const refresh = channels.refresh();
      const receipt = channels.state.channelsRead!;
      emitEvent("config.changed");

      if (transition === "reconnect") {
        update({ phase: "reconnecting" });
        update({ phase: "connected" });
      } else if (transition === "read access") {
        setScopes(["operator.pairing"]);
      } else {
        channels.dispose();
        emitEvent("config.changed");
      }
      await expect(receipt.completion).resolves.toBeNull();
      expect(channels.state.channelsRead).toBeNull();
      if (transition !== "dispose") {
        expect(channels.state.channelsLoading).toBe(false);
      }
      expect(channels.state.channelsSnapshot).toBeNull();
      pending.resolve(createChannelsSnapshot("retired"));
      await refresh;

      expect(request).toHaveBeenCalledOnce();
      expect(channels.state.channelsSnapshot).toBeNull();
    },
  );

  it("clears a failed request generation on reconnect so status can recover", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("status unavailable"))
      .mockResolvedValueOnce(createChannelsSnapshot("recovered"));
    const { channels, update } = createHarness(request);

    await channels.refresh();
    expect(channels.state.channelsError).toBe("status unavailable");
    await expect(channels.state.channelsRead!.completion).resolves.toBe("status unavailable");

    update({ phase: "reconnecting" });
    update({ phase: "connected" });

    expect(channels.state.channelsError).toBeNull();
    await channels.refresh();
    expect(channels.state.channelsSnapshot?.channelLabels.test).toBe("recovered");
    await expect(channels.state.channelsRead!.completion).resolves.toBeNull();
  });

  it("refreshes accepted config without waiting for a stale slow probe", async () => {
    const slowProbe = createDeferred<ChannelsStatusSnapshot | null>();
    const fastRuntime = createDeferred<ChannelsStatusSnapshot | null>();
    const request = vi.fn(async (_method: string, params?: unknown) =>
      (params as { probe?: boolean } | undefined)?.probe ? slowProbe.promise : fastRuntime.promise,
    );
    const { channels, emitEvent } = createHarness(request);
    const runtimeLoaded = createDeferred();
    const fresh = createChannelsSnapshot("fresh");
    channels.subscribe((state) => {
      if (state.channelsSnapshot === fresh && !state.channelsLoading) {
        runtimeLoaded.resolve();
      }
    });

    const probeLoad = channels.refresh(true);
    const probeReceipt = channels.state.channelsRead!;
    await channels.refresh(true);
    expect(channels.state.channelsRead).toBe(probeReceipt);
    emitEvent("config.changed");
    expect(request).toHaveBeenCalledTimes(2);
    const runtimeReceipt = channels.state.channelsRead!;
    expect(runtimeReceipt).not.toBe(probeReceipt);
    await expect(probeReceipt.completion).resolves.toBeNull();

    fastRuntime.resolve(fresh);
    await runtimeLoaded.promise;
    await expect(runtimeReceipt.completion).resolves.toBeNull();
    slowProbe.resolve(createChannelsSnapshot("stale"));
    await probeLoad;

    expect(channels.state.channelsSnapshot?.channelLabels.test).toBe("fresh");
    expect(channels.state.channelsLoading).toBe(false);
  });
});
