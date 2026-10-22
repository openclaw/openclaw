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

function runtimeOnly() {
  return vi.fn(() => {
    throw new Error("runtime hook received an inspection summary");
  });
}

async function inspectSnapshot(
  inspected: object,
  runtime: ChannelAccountSnapshot,
  accountId = runtime.accountId,
  probe?: unknown,
) {
  const runtimeHook = runtimeOnly();
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
      status: {
        buildAccountSnapshot: async () => ({ accountId: "default" }),
      },
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

  it("projects summary-only inspection without invoking runtime account hooks", async () => {
    const inspected = Object.freeze({
      accountId: "primary",
      enabled: true,
      configured: true,
      tokenStatus: "available",
      name: "Configured account",
    });
    await expect(
      inspectSnapshot(
        inspected,
        { accountId: "primary", running: true, lifecycle: "ready" },
        "requested-alias",
      ),
    ).resolves.toMatchObject({
      ...inspected,
      running: true,
      lifecycle: "ready",
    });
  });

  it.each([true, undefined])(
    "preserves prepared runtime metadata while filtering raw inspection with configured=%s",
    async (configured) => {
      const inspected = {
        enabled: true,
        configured,
        botToken: "raw-inspection-token",
        publicKey: "raw-inspection-key",
        application: { privateCredential: "raw-inspection-value" },
      };
      const cachedProbe = { ok: true, source: "recorded" };
      const freshProbe = configured ? { ok: false, source: "requested" } : undefined;
      const runtime = Object.freeze({
        accountId: "primary",
        running: true,
        application: { intents: { messageContent: "disabled" } },
        bot: { username: "recorded-bot" },
        audit: { unresolvedChannels: 1 },
        probe: cachedProbe,
        baseUrl: ["https://", "user", ":", "pass", "@chat.example.test/?token=", "secret"].join(""),
      });

      const snapshot = await inspectSnapshot(inspected, runtime, "primary", freshProbe);

      expect(snapshot).toMatchObject({
        configured,
        running: true,
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

  it("redacts a custom status snapshot baseUrl without mutating the resolved account", async () => {
    const rawBaseUrl = ["https://", "user:pass", "@chat.example.test/?token=", "secret"].join("");
    const account = Object.freeze({ baseUrl: rawBaseUrl });
    let receivedAccount: unknown;
    const result = await snapshotAccount(account, {}, ({ account: hookAccount }) => {
      receivedAccount = hookAccount;
      return { accountId: "custom", baseUrl: hookAccount.baseUrl };
    });

    expect(receivedAccount).toBe(account);
    expect(result.baseUrl).toBe("https://chat.example.test/?token=***");
    expect(account.baseUrl).toBe(rawBaseUrl);
  });

  it("preserves lifecycle fields computed by a custom status adapter", async () => {
    const lifecycle = Object.freeze({
      accountId: "default",
      linked: true,
      running: false,
      connected: false,
      lastError: "probe failed",
    });
    await expect(
      snapshotAccount({ enabled: true, configured: true }, {}, () => lifecycle),
    ).resolves.toMatchObject({
      ...lifecycle,
      configured: true,
    });
  });

  it("uses descriptor linkage when no live link resolver exists", async () => {
    await expect(
      snapshotAccount(
        { enabled: true, configured: true },
        {
          describeAccount: () => ({ accountId: "default", configured: true, linked: false }),
        },
      ),
    ).resolves.toMatchObject({
      configured: true,
      linked: false,
      running: false,
      stateReason: "not linked",
      lastError: null,
    });
  });

  it("does not inspect linkage when the account is unconfigured", async () => {
    const isLinked = vi.fn(() => {
      throw new Error("linkage unavailable");
    });
    await expect(
      snapshotAccount(
        { enabled: true, configured: false },
        {
          isConfigured: () => false,
          isLinked,
        },
      ),
    ).resolves.toMatchObject({
      configured: false,
      stateReason: "not configured",
      lastError: null,
    });
    expect(isLinked).not.toHaveBeenCalled();
  });
});
