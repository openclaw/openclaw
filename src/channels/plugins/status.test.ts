import { describe, expect, it, vi } from "vitest";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { buildChannelAccountSnapshotFromAccount, resolveChannelAccountSnapshot } from "./status.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelAccountSnapshot } from "./types.public.js";

function snapshotAccount<T>(
  account: T,
  config: Partial<ChannelPlugin<T>["config"]>,
  buildAccountSnapshot?: NonNullable<ChannelPlugin<T>["status"]>["buildAccountSnapshot"],
) {
  return buildChannelAccountSnapshotFromAccount({
    cfg: {},
    accountId: "default",
    plugin: { config, status: { buildAccountSnapshot } } as unknown as ChannelPlugin<T>,
    account,
  });
}

async function inspectSnapshot(
  inspected: object,
  runtime: ChannelAccountSnapshot,
  accountId = runtime.accountId,
  probe?: unknown,
) {
  const runtimeHook = vi.fn(() => {
    throw new Error("runtime hook received an inspection summary");
  });
  const plugin = {
    id: "inspection-fixture",
    config: {
      inspectAccount: () => inspected,
      resolveAccount: runtimeHook,
      isEnabled: runtimeHook,
      isConfigured: runtimeHook,
      describeAccount: runtimeHook,
    },
    status: { buildAccountSnapshot: runtimeHook },
  } as unknown as ChannelPlugin;
  const result = await resolveChannelAccountSnapshot({
    plugin,
    cfg: {},
    accountId,
    runtime,
    probe,
  });
  expect(runtimeHook).not.toHaveBeenCalled();
  return result;
}

describe("buildChannelAccountSnapshotFromAccount", () => {
  it("does not inspect linkage after the configured check is cancelled", async () => {
    const abort = new AbortController();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const isConfigured = vi.fn(async () => {
      started.resolve();
      await gate.promise;
      return true;
    });
    const isLinked = vi.fn(() => "linked" as const);
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: "test", config: { isConfigured, isLinked } }),
      status: { buildAccountSnapshot: async () => ({ accountId: "default" }) },
    };
    const pending = buildChannelAccountSnapshotFromAccount({
      plugin,
      cfg: {},
      accountId: "default",
      account: {},
      assertActive: () => abort.signal.throwIfAborted(),
    });
    await started.promise;
    abort.abort();
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(isLinked).not.toHaveBeenCalled();
    expect(isConfigured).toHaveBeenCalledOnce();
  });

  it("preserves runtime facts unless the inspector supplies them: disabled", async () => {
    const runtime = Object.freeze({
      accountId: "default",
      enabled: false,
      configured: true,
      running: false,
      lastError: "recorded failure",
    });
    await expect(inspectSnapshot({ name: "External account" }, runtime)).resolves.toMatchObject({
      ...runtime,
      stateReason: "disabled",
    });
  });

  it.each([true, undefined])(
    "preserves prepared runtime metadata while filtering raw inspection with configured=%s",
    async (configured) => {
      const inspected = Object.freeze({
        accountId: "primary",
        enabled: true,
        configured,
        tokenStatus: "available",
        name: "Configured account",
        botToken: "raw-inspection-token",
        publicKey: "raw-inspection-key",
        application: { privateCredential: "raw-inspection-value" },
      });
      const cachedProbe = { ok: true, source: "recorded" };
      const freshProbe = configured ? { ok: false, source: "requested" } : undefined;
      const runtime = Object.freeze({
        accountId: "primary",
        running: true,
        lifecycle: "ready",
        application: { intents: { messageContent: "disabled" } },
        bot: { username: "recorded-bot" },
        audit: { unresolvedChannels: 1 },
        probe: cachedProbe,
        baseUrl: ["https://", "user", ":", "pass", "@chat.example.test/?token=", "secret"].join(""),
      });

      const snapshot = await inspectSnapshot(inspected, runtime, "requested-alias", freshProbe);

      expect(snapshot).toMatchObject({
        accountId: "primary",
        enabled: true,
        configured,
        running: true,
        lifecycle: "ready",
        tokenStatus: "available",
        name: "Configured account",
        application: runtime.application,
        bot: runtime.bot,
        audit: runtime.audit,
        probe: freshProbe ?? cachedProbe,
        baseUrl: "https://chat.example.test/?token=***",
      });
      expect(snapshot).not.toHaveProperty("botToken");
      expect(snapshot).not.toHaveProperty("publicKey");
      expect(JSON.stringify(snapshot)).not.toContain("raw-inspection");
      expect(runtime.baseUrl).toContain("user:pass@");
      expect(runtime.probe).toBe(cachedProbe);
    },
  );

  it("preserves custom lifecycle fields and redacts its URL without mutating the account", async () => {
    const rawBaseUrl = ["https://", "user:pass", "@chat.example.test/?token=", "secret"].join("");
    const account = Object.freeze({ enabled: true, configured: true, baseUrl: rawBaseUrl });
    const lifecycle = Object.freeze({
      accountId: "custom",
      linked: true,
      running: false,
      connected: false,
      lastError: "probe failed",
    });
    let receivedAccount: unknown;
    const result = await snapshotAccount(account, {}, ({ account: hookAccount }) => {
      receivedAccount = hookAccount;
      return Object.freeze({ ...lifecycle, baseUrl: hookAccount.baseUrl });
    });
    expect(receivedAccount).toBe(account);
    expect(result).toMatchObject({
      ...lifecycle,
      configured: true,
      baseUrl: "https://chat.example.test/?token=***",
    });
    expect(account.baseUrl).toBe(rawBaseUrl);
  });

  it.each([true, false])(
    "resolves descriptor or unconfigured linkage: configured=%s",
    async (configured) => {
      const isLinked = vi.fn(() => {
        throw new Error("linkage unavailable");
      });
      const config = configured
        ? { describeAccount: () => ({ accountId: "default", configured, linked: false }) }
        : { isConfigured: () => false, isLinked };
      await expect(snapshotAccount({ enabled: true, configured }, config)).resolves.toMatchObject({
        configured,
        ...(configured ? { linked: false, running: false } : {}),
        stateReason: configured ? "not linked" : "not configured",
        lastError: null,
      });
      expect(isLinked).not.toHaveBeenCalled();
    },
  );
});
