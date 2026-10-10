import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { WEIXIN_CHANNEL_ICON } from "./plugin-presentation.ts";
import { createChannelsViewProps } from "./view.test-support.ts";
import { renderWeixinLogin } from "./view.weixin.ts";

const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jcxkAAAAASUVORK5CYII=";
function fixture(enabled = false) {
  const props = createChannelsViewProps(null, null);
  props.presentation = {
    pluginCatalog: { plugins: [{ id: "openclaw-weixin", enabled }] },
    pluginIconUrls: {},
  } as typeof props.presentation;
  const container = document.createElement("div");
  return {
    props,
    container,
    draw() {
      render(renderWeixinLogin(props), container);
    },
  };
}
describe("installed Weixin QR entry", () => {
  afterEach(async () => {
    await i18n.setLocale("en");
  });
  it("shows persisted running facts after refresh and offers explicit reconnect without starting login", () => {
    const f = fixture(true);
    f.props.onWeixinStart = vi.fn();
    f.props.channels.weixinLogin = undefined;
    f.props.channels.channelsSnapshot = {
      ts: 0,
      channelOrder: ["openclaw-weixin"],
      channelLabels: {},
      channels: { "openclaw-weixin": { configured: true, running: true } },
      channelAccounts: {},
      channelDefaultAccountId: {},
    };
    f.draw();
    expect(f.container.querySelector("h2")?.textContent).toBe("Personal Weixin");
    expect(f.container.textContent).toContain("Running");
    expect(f.container.querySelector("button")?.textContent).toContain("Reconnect");
    expect(f.container.querySelector(".channels-wizard__qr img")).toBeNull();
    expect(f.props.onWeixinStart).not.toHaveBeenCalled();
    expect(f.props.channels.weixinLogin).toBeUndefined();
    f.container.querySelector("button")!.click();
    expect(f.props.onWeixinStart).toHaveBeenCalledOnce();
  });

  it.each([false, undefined])(
    "keeps saved login distinct from running=%s or connected",
    (running) => {
      const f = fixture(true);
      f.props.channels.channelsSnapshot = {
        ts: 0,
        channelOrder: ["openclaw-weixin"],
        channelLabels: {},
        channels: {
          "openclaw-weixin": { configured: true, ...(running === undefined ? {} : { running }) },
        },
        channelAccounts: {},
        channelDefaultAccountId: {},
      };
      f.draw();
      expect(f.container.querySelector("button")?.textContent).toContain("Reconnect");
      expect(f.container.textContent).toContain("Configured");
      expect(f.container.textContent).not.toContain("Connected");
    },
  );

  it("uses the default account's saved configuration when summary is absent and preserves unknown connect", () => {
    const f = fixture(true);
    f.props.channels.channelsSnapshot = {
      ts: 0,
      channelOrder: ["openclaw-weixin"],
      channelLabels: {},
      channels: {},
      channelAccounts: { "openclaw-weixin": [{ accountId: "saved", configured: true }] },
      channelDefaultAccountId: { "openclaw-weixin": "saved" },
    };
    f.draw();
    expect(f.container.querySelector("button")?.textContent).toContain("Reconnect");
    f.props.channels.channelsSnapshot.channelAccounts = {};
    f.draw();
    expect(f.container.querySelector("button")?.textContent).toContain("Connect");
    expect(f.container.querySelector("button")?.textContent).not.toContain("Reconnect");
  });

  it("renders the local Weixin mark when the installed plugin has no icon", () => {
    const f = fixture(true);
    f.draw();
    expect(
      f.container.querySelector(".weixin-login__identity .channels-tile img")?.getAttribute("src"),
    ).toBe(WEIXIN_CHANNEL_ICON);
  });

  it("keeps the loaded channel entry discoverable when plugin inventory fails", () => {
    const f = fixture();
    f.props.presentation = { pluginCatalog: null } as typeof f.props.presentation;
    f.props.channels.channelsSnapshot = {
      ts: 0,
      channelOrder: ["openclaw-weixin"],
      channelLabels: {},
      channels: {},
      channelAccounts: {},
      channelDefaultAccountId: {},
    };
    f.draw();
    expect(f.container.querySelector("button")?.textContent).toContain("Connect");
  });
  it("offers enable-and-connect for a disabled installed plugin absent from channel status", () => {
    const f = fixture();
    f.props.onWeixinStart = vi.fn();
    f.draw();
    const button = f.container.querySelector("button")!;
    expect(button.textContent).toContain("Enable and connect");
    button.click();
    expect(f.props.onWeixinStart).toHaveBeenCalledOnce();
  });
  it("hides login controls without admin authority and blocks dirty config", () => {
    const f = fixture();
    f.props.canAdmin = false;
    f.draw();
    expect(f.container.querySelector("button.primary")).toBeNull();
    expect(f.container.textContent).toContain("Open details");
    f.props.canAdmin = true;
    f.props.config.configFormDirty = true;
    f.draw();
    expect(f.container.querySelector("button")!.disabled).toBe(true);
  });
  it("renders bounded current PNG only, allowing close during a pending poll", () => {
    const f = fixture(true);
    f.props.channels.weixinLogin = {
      phase: "waiting",
      qrDataUrl: png,
      expiresAtMs: Date.now() + 60_000,
      sessionKey: "test",
      busy: true,
      message: null,
    };
    f.props.onWeixinClose = vi.fn();
    f.draw();
    expect(f.container.querySelector(".channels-wizard__qr img")?.getAttribute("src")).toBe(png);
    f.container.querySelector<HTMLButtonElement>(".weixin-login__actions button")!.click();
    expect(f.props.onWeixinClose).toHaveBeenCalledOnce();
    f.props.channels.weixinLogin.expiresAtMs = Date.now() - 1;
    f.draw();
    expect(f.container.querySelector(".channels-wizard__qr img")).toBeNull();
  });
  it("submits verification through the callback and immediately clears the secret field", () => {
    const f = fixture(true);
    f.props.channels.weixinLogin = {
      phase: "verification",
      qrDataUrl: null,
      expiresAtMs: null,
      sessionKey: null,
      busy: false,
      message: null,
    };
    f.props.onWeixinVerify = vi.fn();
    f.draw();
    const input = f.container.querySelector("input")!;
    input.value = "123456";
    f.container
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(f.props.onWeixinVerify).toHaveBeenCalledWith("123456");
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
  });
});
