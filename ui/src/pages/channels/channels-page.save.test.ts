import { createComponent } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { editChannelField } from "./channel-config-draft.ts";
import {
  channelSnapshot,
  createContext,
  createGateway,
  profileButton,
  sources,
} from "./channels-page.test-support.ts";
import { ChannelsPage } from "./channels-page.tsx";
import { pairingSnapshot } from "./pairing.test-support.ts";

const unmounts: Array<() => void> = [];

function mountPage(context: ApplicationContext): HTMLElement {
  const mounted = mountSolid(() => createComponent(ChannelsPage, {}), {
    wrapper: (props) =>
      createComponent(ApplicationProvider, {
        value: context,
        get children() {
          return props.children;
        },
      }),
  });
  unmounts.push(mounted.unmount);
  flush();
  return mounted.container;
}

async function settle() {
  flush();
  await Promise.resolve();
  flush();
}

const findButton = (root: ParentNode, selector: string) =>
  root.querySelector<HTMLButtonElement>(selector)!;
const text = (root: ParentNode, selector: string) => root.querySelector(selector)?.textContent;
const objectSchema = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
});

afterEach(() => {
  for (const unmount of unmounts.splice(0)) {
    unmount();
  }
  for (const source of sources.splice(0)) {
    source.runtimeConfig.dispose();
    source.channels.dispose();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("ChannelsPage save against a file changed elsewhere", () => {
  const telegram = (values: Record<string, unknown>) => ({ channels: { telegram: values } });
  const before = telegram({
    allowFrom: ["111", "222"],
    dmPolicy: "allowlist",
    groups: { "-1001": { requireMention: true } },
  });
  const configSnapshot = (config: Record<string, unknown>, hash: string) => ({
    config,
    sourceConfig: config,
    hash,
    raw: JSON.stringify(config),
    valid: true,
    issues: [],
  });
  const schema = objectSchema({
    channels: objectSchema({
      telegram: objectSchema({
        dmPolicy: {
          type: "string",
          title: "DM policy",
          enum: ["pairing", "allowlist", "open", "disabled"],
        },
        allowFrom: { type: "array", title: "Allow from", items: { type: "string" } },
        groups: {
          type: "object",
          title: "Groups",
          additionalProperties: objectSchema({ requireMention: { type: "boolean" } }),
        },
        textChunkLimit: { type: "number", title: "Text chunk limit" },
      }),
    }),
  });

  async function openTelegram(options: { patch?: () => unknown } = {}) {
    let file = configSnapshot(before, "h0");
    const gateway = createGateway(undefined, {
      "config.get": () => structuredClone(file),
      "config.patch": options.patch ?? (() => ({ ok: true, config: file.config, hash: "h2" })),
    });
    gateway.emit({
      hello: {
        auth: { role: "operator", scopes: ["operator.admin", "operator.read"] },
        features: { methods: ["config.get", "config.patch", "config.schema"] },
      } as unknown as ApplicationGatewaySnapshot["hello"],
    });
    const source = createContext(gateway);
    source.channels.state.channelsSnapshot = channelSnapshot({
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
      channels: { telegram: { configured: true, running: true, connected: true } },
    });
    source.channels.state.pairingSnapshot = pairingSnapshot({
      accounts: [],
      requests: [],
      commandOwnerConfigured: true,
    });
    Object.assign(source.runtimeConfig.state, {
      configSchema: schema,
      configUiHints: Object.fromEntries(
        ["dmPolicy", "allowFrom", "groups", "textChunkLimit"].map((key) => [
          `channels.telegram.${key}`,
          { advanced: false },
        ]),
      ),
    });
    await source.runtimeConfig.refresh();
    const request = vi.spyOn(gateway.snapshot.client!, "request");
    const page = mountPage(source.context);
    await settle();
    findButton(page, ".channels-item").click();
    await settle();
    return {
      gateway,
      source,
      page,
      request,
      patches: () => request.mock.calls.filter(([method]) => method === "config.patch"),
      /** Another client writes the file; this page hears of it as it would from config.changed. */
      changeElsewhere: async (config: Record<string, unknown>, hash: string) => {
        file = configSnapshot(config, hash);
        await source.runtimeConfig.refresh();
        await settle();
      },
      setFile: async (config: Record<string, unknown>, hash: string) => {
        file = configSnapshot(config, hash);
      },
    };
  }

  /** A real form edit, so the page records it through its own onConfigPatch. */
  async function choose(page: HTMLElement, group: string, label: string) {
    const select = page.querySelector<HTMLSelectElement>(`select[aria-label="${group}"]`);
    expect(select, `Missing ${group} select`).not.toBeNull();
    const option = Array.from(select!.options).find((entry) => entry.label === label);
    expect(option, `Missing ${group} option ${label}`).toBeDefined();
    select!.value = option!.value;
    select!.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
  }

  function edit(
    source: Awaited<ReturnType<typeof openTelegram>>["source"],
    key: string,
    value: unknown,
  ) {
    const path = ["channels", "telegram", key];
    editChannelField(source.channels, source.runtimeConfig.state, "telegram", { path, value });
  }

  /** The message of what this channel's Save reported, without its buttons. */
  const alertText = (page: HTMLElement) => {
    const notice = page.querySelector(".channels-detail__feedback .settings-save-indicator");
    return notice?.querySelector("span")?.textContent ?? null;
  };

  it("writes nothing over fields changed elsewhere, then lets the newer values win", async () => {
    const { page, source, patches, changeElsewhere } = await openTelegram();
    // Another page's failure never shows in this channel's dialog.
    source.runtimeConfig.state.lastError = "Another page failed";
    await choose(page, "DM policy", "Pairing");
    edit(source, "allowFrom", ["111"]);
    edit(source, "groups", {
      "-1001": { requireMention: true },
      "-1002": { requireMention: true },
    });
    await settle();
    expect(alertText(page)).toBeNull();

    await changeElsewhere(
      telegram({
        allowFrom: ["111", "222", "333"],
        dmPolicy: "disabled",
        groups: { "-1001": { requireMention: true }, "-1003": { requireMention: true } },
      }),
      "h1",
    );
    findButton(page, ".channels-detail .btn.primary").click();
    await waitForSolid(() =>
      expect(alertText(page)).toBe("Settings changed elsewhere: DM policy, Allow from, Groups"),
    );
    expect(patches()).toHaveLength(0);
    expect(source.channels.state.configEdits.telegram).toHaveLength(3);
    expect(text(page, ".channels-detail__footer .channels-detail__status")).toBe("Unsaved changes");

    profileButton(page, "Reload").click();
    await waitForSolid(() => expect(source.channels.state.configEdits.telegram).toBeUndefined());
    expect(patches()).toHaveLength(0);
    expect(alertText(page)).toBeNull();
  });

  it("writes the edits over the newer values only on Overwrite", async () => {
    const { page, source, patches, changeElsewhere } = await openTelegram();
    await choose(page, "DM policy", "Pairing");
    edit(source, "allowFrom", ["111"]);
    await changeElsewhere(
      telegram({ ...before.channels.telegram, allowFrom: ["111", "222", "333"] }),
      "h1",
    );
    findButton(page, ".channels-detail .btn.primary").click();
    await waitForSolid(() =>
      expect(alertText(page)).toBe("Settings changed elsewhere: Allow from"),
    );
    expect(patches()).toHaveLength(0);

    profileButton(page, "Overwrite").click();
    await waitForSolid(() => expect(patches()).toHaveLength(1));
    const params = patches()[0]![1] as { raw: string; baseHash: string; replacePaths?: string[] };
    expect(params.baseHash).toBe("h1");
    expect(params.replacePaths).toEqual(["channels.telegram.allowFrom"]);
    expect(JSON.parse(params.raw)).toEqual({
      channels: { telegram: { dmPolicy: "pairing", allowFrom: ["111"] } },
    });
    await waitForSolid(() =>
      expect(text(page, ".channels-detail__footer .channels-detail__status")).toBe("Saved"),
    );
  });

  it("still saves next to a change elsewhere that the edits don't touch", async () => {
    const { page, source, patches, changeElsewhere } = await openTelegram();
    await choose(page, "DM policy", "Pairing");
    const elsewhere = telegram({
      allowFrom: ["111", "222", "333"],
      dmPolicy: "allowlist",
      textChunkLimit: 2000,
      groups: { "-1001": { requireMention: true }, "-1003": { requireMention: true } },
    });
    const path = ["channels", "telegram", "groups", "-1001", "requireMention"];
    editChannelField(source.channels, source.runtimeConfig.state, "telegram", {
      path,
      value: false,
    });
    await changeElsewhere(elsewhere, "h1");
    findButton(page, ".channels-detail .btn.primary").click();
    await waitForSolid(() => expect(patches()).toHaveLength(1));
    const params = patches()[0]![1] as { raw: string; baseHash: string };
    expect(params.baseHash).toBe("h1");
    expect(JSON.parse(params.raw)).toEqual({
      channels: {
        telegram: { dmPolicy: "pairing", groups: { "-1001": { requireMention: false } } },
      },
    });
    await waitForSolid(() =>
      expect(text(page, ".channels-detail__footer .channels-detail__status")).toBe("Saved"),
    );
    expect(alertText(page)).toBeNull();
  });

  it.each([
    ["landed", "Saved", null],
    ["not landed", "Unsaved changes", "Couldn’t save your changes. Save again."],
  ] as const)(
    "reports a Save cut short by a dropped connection once a re-read shows it %s",
    async (outcome, status, alert) => {
      const held = createDeferred<never>();
      const { page, gateway, patches, setFile } = await openTelegram({
        patch: () => held.promise,
      });
      await choose(page, "DM policy", "Pairing");
      findButton(page, ".channels-detail .btn.primary").click();
      await waitForSolid(() => expect(patches()).toHaveLength(1));

      gateway.emit({ phase: "reconnecting" });
      held.reject(new Error("gateway closed"));
      await waitForSolid(() =>
        expect(alertText(page)).toBe("Disconnected while saving. Reconnect to check your changes."),
      );

      if (outcome === "landed") {
        await setFile(telegram({ ...before.channels.telegram, dmPolicy: "pairing" }), "h1");
      }
      gateway.emit({ phase: "connected" });
      await waitForSolid(() => {
        expect(text(page, ".channels-detail__footer .channels-detail__status")).toBe(status);
        expect(alertText(page)).toBe(alert);
      });
      expect(patches()).toHaveLength(1);
    },
  );
});
