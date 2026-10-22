import type { JSX } from "@solidjs/web";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelsStatusSnapshot } from "../../api/types.ts";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import type { SelectPicker } from "../../components/select-picker.ts";
import { i18n } from "../../i18n/lib/translate.ts";
import { channelSnapshotEntryIsActive } from "../../lib/channels/index.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import { updatePickers, openPicker, choosePickerValue } from "../../test-helpers/select-picker.ts";
import {
  pairingAccount as personal,
  pairingRequest as request,
  pairingSnapshot,
} from "./pairing.test-support.ts";
import { ChannelConfig } from "./view.config.tsx";
import { renderChannelDetail } from "./view.detail.tsx";
import {
  renderChannelPairingDetail,
  renderChannelPairingPrompt,
  renderChannelPairingQueue,
} from "./view.pairing.tsx";
import { resolveChannelDisplayState } from "./view.shared.tsx";
import type { ChannelsViewTestOverrides } from "./view.test-support.ts";
import {
  renderChannelView,
  disposeChannelViews,
  createChannelsViewProps,
  channelSnapshot,
  text,
  texts,
} from "./view.test-support.ts";
import { ChannelsView } from "./view.tsx";
import type { ChannelsProps } from "./view.types.ts";

function createProps(snapshot: ChannelsProps["channels"]["channelsSnapshot"]): ChannelsProps {
  return createChannelsViewProps(snapshot, {
    accounts: [],
    requests: [],
    commandOwnerConfigured: true,
    limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
  });
}

function renderHub(props: ChannelsProps) {
  return renderChannelView(ChannelsView, props);
}

function mountNavigableHub(current: ChannelsProps) {
  const container = document.createElement("div");
  current.onShowDetail = (selectedChannel) => {
    current.selectedChannel = selectedChannel;
    renderChannelView(ChannelsView, current, container);
  };
  renderChannelView(ChannelsView, current, container);
  return container;
}

function channelProps(
  channels: ChannelsStatusSnapshot["channels"],
  overrides: Partial<ChannelsStatusSnapshot> = {},
) {
  return createProps(channelSnapshot(channels, overrides));
}

const facts = (root: ParentNode) =>
  Array.from(root.querySelectorAll("dt"), (node) => [
    node.textContent?.trim(),
    node.nextElementSibling?.textContent?.trim(),
  ]);
const heading = ".settings-section__heading";
const probeButton = ".settings-row--actions button";
const whatsappStatus = {
  configured: true,
  linked: false,
  running: false,
  connected: false,
  reconnectAttempts: 0,
};

describe("channel hub refresh actions", () => {
  it("keeps both timestamps in icon-button tooltips", () => {
    const onRefresh = vi.fn();
    const onPairingRefresh = vi.fn();
    const props = channelProps({ slack: { configured: true } });
    props.channels.channelsLastSuccess = Date.now();
    props.channels.pairingLastSuccess = Date.now();
    props.onRefresh = onRefresh;
    props.onPairingRefresh = onPairingRefresh;
    const container = renderHub(props);

    const refreshButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Refresh"]'),
    );
    expect(refreshButtons).toHaveLength(2);
    expect(refreshButtons.map((button) => button.textContent?.trim())).toEqual(["", ""]);
    expect(container.textContent).not.toContain("Updated just now");
    expect(
      refreshButtons.map(
        (button) =>
          (button.closest("openclaw-tooltip") as (HTMLElement & { content?: string }) | null)
            ?.content,
      ),
    ).toEqual(["Updated just now", "Updated just now"]);

    refreshButtons[0]!.click();
    refreshButtons[1]!.click();
    expect(onPairingRefresh).toHaveBeenCalledOnce();
    expect(onRefresh).toHaveBeenCalledWith(true);
  });

  it("announces a channel status failure as an alert", () => {
    const props = createProps(channelSnapshot({}, { ts: Date.now() }));
    props.channels.channelsError = "Channel status unavailable";
    const container = renderHub(props);

    expect(
      Array.from(container.querySelectorAll('[role="alert"]'), (alert) => alert.textContent),
    ).toEqual(["Channel status unavailable"]);
  });
});

const channelPlugin: PluginCatalogItem = {
  id: "slack",
  name: "Slack",
  description: "Slack plugin description",
  origin: "bundled",
  installed: true,
  enabled: false,
  state: "disabled",
  hasIcon: true,
};

describe("channels plugin presentation metadata", () => {
  it("uses matching plugins.list metadata and package icons or placeholders throughout setup", () => {
    const props = channelProps(
      { slack: { configured: false } },
      {
        channelDetailLabels: { slack: "Legacy channel subtitle" },
      },
    );
    Object.assign(props.presentation, {
      pluginCatalog: { plugins: [channelPlugin], diagnostics: [], mutationAllowed: true },
      pluginIconUrls: { slack: "blob:slack-plugin-icon" },
    });
    props.selectedChannel = "slack";
    props.wizardHost.state = () => ({ phase: "error", channel: "slack", message: "Setup failed" });
    const container = renderHub(props);

    const selectors = [".channels-item", ".channels-detail__header", ".channels-wizard"];
    const icons = () => selectors.map((selector) => container.querySelector(`${selector} img`));
    const iconSources = () => icons().map((icon) => icon?.getAttribute("src") ?? null);
    expect(text(container, ".channels-item .settings-row__title")).toBe("Slack");
    expect(text(container, ".channels-item .settings-row__desc")).toBe(channelPlugin.description);
    expect(text(container, ".channels-wizard h2")).toBe("Set up Slack");
    expect(container.textContent).not.toContain("Legacy channel subtitle");
    expect(iconSources()).toEqual(Array(3).fill("blob:slack-plugin-icon"));
    const originalIcons = icons();
    for (const [index, selector] of selectors.entries()) {
      originalIcons[index]!.dispatchEvent(new Event("error"));
      flush();
      expect(container.querySelector(`${selector} img`)).toBeNull();
      expect(
        container.querySelector(
          `${selector} .channels-tile--fallback, ${selector} .channels-cover--fallback`,
        )?.textContent,
      ).toContain("SL");
    }
    renderChannelView(ChannelsView, props, container);
    expect(icons()).toEqual([null, null, null]);
    Object.assign(props.presentation, { pluginIconUrls: { slack: "blob:replacement-slack-icon" } });
    renderChannelView(ChannelsView, props, container);
    for (const [index, selector] of selectors.entries()) {
      const replacement = container.querySelector(`${selector} img`)!;
      expect(replacement.getAttribute("src")).toBe("blob:replacement-slack-icon");
      originalIcons[index]!.dispatchEvent(new Event("error"));
      flush();
      expect(container.querySelector(`${selector} img`)).toBe(replacement);
    }
    Object.assign(props.presentation, { pluginIconUrls: { slack: "blob:slack-plugin-icon" } });
    renderChannelView(ChannelsView, props, container);
    expect(iconSources()).toEqual(Array(3).fill("blob:slack-plugin-icon"));
    Object.assign(props.presentation, {
      pluginIconUrls: {},
      pluginCatalog: {
        ...props.presentation.pluginCatalog,
        plugins: [{ ...channelPlugin, hasIcon: false }],
      },
    });
    renderChannelView(ChannelsView, props, container);
    expect(container.querySelector(".channels-item img")).toBeNull();
  });
});

describe("channels setup access", () => {
  it("keeps unconfigured recommended channels available after one channel is configured", () => {
    const props = channelProps(
      { slack: { configured: true } },
      {
        channelLabels: { slack: "Slack" },
        channelMeta: [{ id: "slack", label: "Slack", detailLabel: "Slack Bot" }],
      },
    );
    const container = renderHub(props);

    const availableLabels = texts(container, ".channels-item__detail .settings-row__title");
    expect(availableLabels).toEqual([
      "whatsapp",
      "telegram",
      "discord",
      "googlechat",
      "signal",
      "imessage",
      "nostr",
    ]);
  });

  it("replaces setup actions with an admin-required notice for non-admin viewers", () => {
    const onStartSetup = vi.fn();
    const props = channelProps({ telegram: { configured: false } });
    props.canAdmin = false;
    props.onStartSetup = onStartSetup;
    const container = renderHub(props);

    expect(container.textContent).toContain(
      "Browsing only. Channel setup requires operator.admin access.",
    );
    expect(texts(container, "button")).not.toContain("Set up");
    expect(container.textContent).not.toContain("More channels…");
    expect(onStartSetup).not.toHaveBeenCalled();
  });
});

describe("channel row actions", () => {
  it.each([
    { list: "connected", action: "details", update: "reorder" },
    { list: "available", action: "details", update: "reorder" },
    { list: "available", action: "setup", update: "reorder" },
    { list: "available", action: "details", update: "connect" },
    { list: "available", action: "setup", update: "connect" },
  ])(
    "keeps $list $action clicks on their channel after a status $update",
    ({ list, action, update }) => {
      const configured = list === "connected";
      const snapshot = channelSnapshot(
        { whatsapp: { configured }, telegram: { configured } },
        {
          channelLabels: { whatsapp: "WhatsApp", telegram: "Telegram" },
        },
      );
      const props = createProps(snapshot);
      const onAction = vi.fn();
      if (action === "setup") {
        props.onStartSetup = onAction;
      } else {
        props.onShowDetail = onAction;
      }
      const container = renderHub(props);
      const row = Array.from(container.querySelectorAll<HTMLElement>(".channels-item")).find(
        (element) => element.querySelector(".settings-row__title")?.textContent === "Telegram",
      )!;
      const button = row.matches("button")
        ? (row as HTMLButtonElement)
        : row.querySelector<HTMLButtonElement>(
            action === "setup" ? ".btn" : ".channels-item__detail",
          )!;

      props.channels.channelsSnapshot = {
        ...snapshot,
        ts: 2,
        ...(update === "connect"
          ? { channels: { ...snapshot.channels, whatsapp: { configured: true } } }
          : { channelOrder: ["telegram", "whatsapp"] }),
      };
      renderChannelView(ChannelsView, props, container);
      expect(container.contains(button)).toBe(true);
      button.click();

      expect(onAction).toHaveBeenCalledExactlyOnceWith("telegram");
    },
  );
});

describe("channel status issues", () => {
  function createRunningSnapshot(): ChannelsStatusSnapshot {
    return channelSnapshot(
      {
        discord: { configured: true, running: true, connected: true, lastError: null },
        slack: { configured: true, running: true },
      },
      {
        channelLabels: { discord: "Discord", slack: "Slack" },
        channelAccounts: {
          discord: [
            { accountId: "default", configured: true, running: true, lastError: null },
            { accountId: "community", configured: true, running: true, lastError: null },
          ],
        },
        channelDefaultAccountId: { discord: "default" },
      },
    );
  }

  function findChannelRow(container: HTMLElement, label: string) {
    return Array.from(container.querySelectorAll<HTMLButtonElement>("button.channels-item")).find(
      (row) => row.querySelector(".settings-row__title")?.textContent === label,
    )!;
  }

  it("shows account policy and pending reload issues without hiding a running transport", () => {
    const snapshot = createRunningSnapshot();
    snapshot.statusIssues = [
      {
        channel: "discord",
        accountId: "community",
        kind: "config",
        message: "Guild allowlist is empty.",
        fix: "Add the intended guild.",
      },
      {
        channel: "discord",
        accountId: "community",
        kind: "runtime",
        message: "Channel restart is pending.",
        fix: "Wait, then refresh status.",
      },
    ];
    const props = createProps(snapshot);
    const container = mountNavigableHub(props);

    const discord = findChannelRow(container, "Discord");
    expect(text(discord, ".settings-status")).toBe("Needs attention");
    expect(discord.querySelector(".settings-row__desc")?.textContent).toBe(
      snapshot.statusIssues[0]!.message,
    );
    expect(text(findChannelRow(container, "Slack"), ".settings-status")).toBe("Running");
    expect(container.textContent).not.toContain("Some channel checks did not finish");

    discord.click();

    const detail = container.querySelector(".channels-detail")!;
    const notices = detail.querySelectorAll('[role="note"]');
    expect(notices).toHaveLength(2);
    snapshot.statusIssues.forEach((issue, index) => {
      expect(notices[index]!.textContent).toContain("Needs attention · community");
      expect(notices[index]!.textContent).toContain(issue.message);
      expect(notices[index]!.textContent).toContain(issue.fix);
    });
    expect(facts(detail)).toContainEqual(["Running", "Yes"]);

    props.channels.channelsSnapshot = { ...snapshot, ts: 2, statusIssues: [] };
    renderChannelView(ChannelsView, props, container);

    expect(text(findChannelRow(container, "Discord"), ".settings-status")).toBe("Running");
    expect(container.querySelectorAll('.channels-detail [role="note"]')).toHaveLength(0);
    expect(container.textContent).not.toContain(snapshot.statusIssues[0]!.message);
  });

  it("escapes and redacts plugin issue text in the row and recovery notice", () => {
    const snapshot = createRunningSnapshot();
    snapshot.statusIssues = [
      {
        channel: "discord",
        accountId: "<b>community</b>",
        kind: "config",
        message: 'Policy blocks <img src="x" onerror="alert(1)"> with Bearer abcdefghijkl',
        fix: "Check <script>alert(1)</script> with Bearer mnopqrstuvwxyz",
      },
    ];
    const props = createProps(snapshot);
    props.selectedChannel = "discord";
    const container = renderHub(props);

    const row = findChannelRow(container, "Discord");
    const notice = container.querySelector('.channels-detail [role="note"]')!;
    expect(row.textContent).toContain('<img src="x" onerror="alert(1)"> with Bearer [redacted]');
    expect(notice.textContent).toContain("<b>community</b>");
    expect(notice.textContent).toContain("<script>alert(1)</script> with Bearer [redacted]");
    expect(container.textContent).not.toContain("abcdefghijkl");
    expect(container.textContent).not.toContain("mnopqrstuvwxyz");
    expect(row.querySelector(".settings-row__desc img")).toBeNull();
    expect(notice.querySelector("b, img, script")).toBeNull();
  });

  it("keeps transport failures and partial probe diagnostics distinct from policy issues", () => {
    const snapshot = createRunningSnapshot();
    snapshot.channels.discord = { configured: true, running: true, lastError: "Connection closed" };
    snapshot.partial = true;
    snapshot.warnings = ["Slack probe timed out."];
    const props = createProps(snapshot);
    props.selectedChannel = "discord";
    const container = renderHub(props);

    expect(text(findChannelRow(container, "Discord"), ".settings-status")).toBe("Needs attention");
    expect(text(findChannelRow(container, "Slack"), ".settings-status")).toBe("Running");
    expect(container.textContent).toContain("Connection closed");
    expect(container.textContent).toContain("Slack probe timed out.");
    expect(container.querySelectorAll('.channels-detail [role="note"]')).toHaveLength(0);
  });
});

function renderChannelDetailFixture(
  channelId: string,
  channels: ChannelsStatusSnapshot["channels"],
  options: {
    label?: string;
    loading?: boolean;
    configError?: string;
    onRefresh?: ChannelsProps["onRefresh"];
    accounts?: ChannelsStatusSnapshot["channelAccounts"][string];
  } = {},
) {
  const props = channelProps(channels, {
    channelLabels: { [channelId]: options.label ?? channelId },
    channelAccounts: { [channelId]: options.accounts ?? [] },
  });
  props.channels.channelsLoading = options.loading ?? false;
  props.config.lastError = options.configError ?? null;
  if (options.onRefresh) {
    props.onRefresh = options.onRefresh;
  }
  return renderChannelView(renderChannelDetail, {
    channelId,
    label: options.label ?? channelId,
    props,
    onClose: () => {},
    onSetup: () => {},
  });
}

const objectSchema = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: "object",
  properties,
});
describe("channel config advanced tier", () => {
  it("hides advanced channel settings behind the disclosure by default", () => {
    const { container, onShowAdvancedSettings } = renderWhatsAppConfigForm(false);

    expect(container.textContent).toContain("Enabled");
    expect(container.textContent).not.toContain("Timeout Ms");
    const disclosure = container.querySelector<HTMLDetailsElement>(
      "details.config-advanced-disclosure",
    );
    expect(disclosure?.open).toBe(false);
    expect(disclosure?.querySelector("summary")?.textContent?.trim()).toBe("Advanced settings");
    disclosure!.open = true;
    disclosure!.dispatchEvent(new Event("toggle"));
    expect(onShowAdvancedSettings).toHaveBeenCalledWith(true);
  });

  it("keeps the collapse control for channels whose settings are all advanced", () => {
    const { container, onShowAdvancedSettings } = renderWhatsAppConfigForm(true, {
      ...CHANNEL_TIER_HINTS,
      "channels.whatsapp.enabled": { advanced: true },
    });

    const disclosure = container.querySelector<HTMLDetailsElement>(
      "details.config-advanced-disclosure",
    );
    expect(disclosure?.open).toBe(true);
    disclosure!.open = false;
    disclosure!.dispatchEvent(new Event("toggle"));
    expect(onShowAdvancedSettings).toHaveBeenCalledWith(false);
  });

  it("renders field help from the resolved hints", () => {
    const props = channelProps({ whatsapp: whatsappStatus });
    props.config.configSchema = objectSchema({
      channels: objectSchema({
        whatsapp: objectSchema({
          enabled: { type: "boolean" },
        }),
      }),
    });
    props.config.configUiHints = {
      "channels.whatsapp.enabled": { advanced: false, help: "Turn this channel on or off." },
    };
    props.config.configForm = { channels: { whatsapp: { enabled: true } } };
    const container = renderChannelView(
      (viewProps: ChannelsProps) => <ChannelConfig channelId="whatsapp" props={viewProps} />,
      props,
    );

    expect(texts(container, ".settings-row__desc")).toContain("Turn this channel on or off.");
  });
});

describe("channel detail", () => {
  it("shows an escaped configuration save error inside the Nostr editor", () => {
    const message = 'Gateway rejected <img src="x" onerror="alert(1)">';
    const container = renderChannelDetailFixture(
      "nostr",
      { nostr: null },
      { configError: message },
    );
    const alert = container.querySelector(".channels-detail [role=alert]");

    expect(alert?.textContent).toBe(message);
    expect(alert?.querySelector("img")).toBeNull();
  });

  // The standard-channel E2E owns per-plugin titles, credentials, audience and base URL.
  it("renders the remaining mode/common facts and invokes the probe action", () => {
    const onRefresh = vi.fn();
    const container = renderChannelDetailFixture(
      "telegram",
      { telegram: { configured: true, running: true, mode: "polling" } },
      { onRefresh },
    );
    expect(facts(container)).toEqual([
      ["Configured", "Yes"],
      ["Running", "Yes"],
      ["Mode", "polling"],
      ["Last start", "n/a"],
      ["Last connection check", "n/a"],
    ]);
    container.querySelector<HTMLButtonElement>(probeButton)!.click();
    expect(onRefresh).toHaveBeenCalledWith(true);
  });

  it("keeps the cold recommended Google Chat detail available", () => {
    const props = createProps(null);
    props.selectedChannel = "googlechat";
    const container = renderHub(props);
    const detail = container.querySelector(".channels-detail")!;

    expect(text(detail, heading)).toBe("Google Chat");
    expect(text(detail, probeButton)).toBe("Check connection");
    expect(texts(detail, "dt")).toContain("Last connection check");
    expect(detail.textContent).not.toContain("Channel status and configuration.");
  });

  it("projects an in-flight read onto its Probe action", () => {
    const onRefresh = vi.fn();
    const container = renderChannelDetailFixture(
      "signal",
      { signal: { configured: true, running: true } },
      { loading: true, onRefresh },
    );
    const probe = container.querySelector<HTMLButtonElement>(probeButton);

    expect(probe?.disabled).toBe(true);
    expect(probe?.getAttribute("aria-busy")).toBe("true");
    expect(probe?.textContent?.trim()).toBe("Refreshing…");
    probe?.click();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("keeps missing Google Chat status unknown while other known channels are stopped", () => {
    const google = renderChannelDetailFixture("googlechat", { googlechat: null });
    const googlePresent = renderChannelDetailFixture("googlechat", { googlechat: {} });
    const discord = renderChannelDetailFixture("discord", { discord: null });
    expect(facts(google)).toContainEqual(["Running", "n/a"]);
    expect(facts(googlePresent)).toContainEqual(["Running", "No"]);
    expect(facts(discord)).toContainEqual(["Running", "No"]);
  });

  it.each([0, 1, 2])("shows Telegram account rows only above its %i-account threshold", (count) => {
    const accounts = [
      {
        accountId: "first",
        name: "First",
        configured: true,
        running: false,
        probe: { bot: { username: "first_bot" } },
      },
      { accountId: "second", name: "Second", configured: false, running: true },
    ].slice(0, count);
    const container = renderChannelDetailFixture(
      "telegram",
      { telegram: { running: true } },
      { accounts },
    );
    if (count < 2) {
      expect(container.querySelector("dl")?.textContent).toContain("RunningYes");
      expect(container.textContent).not.toContain("@first_bot");
    } else {
      expect(container.querySelector("dl")).toBeNull();
      const rows = Array.from(container.querySelectorAll(".settings-row")).filter((row) =>
        row.querySelector(".settings-row__title"),
      );
      expect(
        rows.map((row) => [
          row.querySelector(".settings-row__title")?.textContent,
          row.querySelector(".settings-row__desc")?.textContent,
          text(row, ".settings-status"),
        ]),
      ).toEqual([
        ["@first_bot", "first · Configured: Yes", "No"],
        ["Second", "second · Configured: No", "Running"],
      ]);
    }
  });

  it("keeps the bundled display policy for a same-ID custom channel status", () => {
    const container = renderChannelDetailFixture(
      "signal",
      {
        signal: {
          configured: true,
          baseUrl: "https://custom.example",
          lastError: "Custom failure",
          probe: { ok: false, error: "Probe failure" },
          lastStartAt: Date.now(),
          lastProbeAt: Date.now(),
        },
      },
      { label: "Custom Signal" },
    );
    expect(text(container, heading)).toBe("Signal");
    expect(container.textContent).toContain("https://custom.example");
    expect(container.textContent).toContain("Custom failure");
    expect(container.textContent).toContain("Probe failure");
    expect(container.textContent).toContain("just now");
  });

  it("updates the same mounted detail when the locale changes", async () => {
    try {
      await i18n.setLocale("en");
      const container = renderChannelDetailFixture("signal", { signal: {} });
      const english = "signal-cli status and channel configuration.";
      expect(container.textContent).toContain(english);
      await i18n.setLocale("fr");
      flush();
      expect(container.textContent).toContain(i18n.t("channels.signal.subtitle"));
      expect(container.textContent).not.toContain(english);
      await i18n.setLocale("en");
      flush();
      expect(container.textContent).toContain(english);
    } finally {
      await i18n.setLocale("en");
    }
  });

  it.each(["__proto__"])(
    "opens accountless plugin %s from its actual hub row without inherited account values",
    (channelId) => {
      for (const configured of [false, true]) {
        const props = channelProps(
          { [channelId]: { configured, running: configured } },
          {
            channelLabels: { [channelId]: "Custom channel" },
          },
        );
        const container = mountNavigableHub(props);
        const trigger = container.querySelector<HTMLButtonElement>(
          configured ? "button.channels-item" : ".channels-item__detail",
        );

        expect(trigger).toBeInstanceOf(HTMLButtonElement);
        trigger!.click();
        const detail = container.querySelector(".channels-detail");
        expect(text(detail!, heading)).toBe("Custom channel");
        expect(detail?.textContent).toContain("Channel status and configuration.");
        expect(texts(detail!, "dt")).toEqual(["Configured", "Running", "Connected"]);
      }
    },
  );
});

describe("channel display selectors", () => {
  it("keeps disabled channels hidden when neither summary nor accounts are active", () => {
    const props = channelProps(
      { quietchat: {} },
      {
        channelLabels: { quietchat: "Quiet Chat" },
        channelAccounts: {
          quietchat: [
            { accountId: "default", configured: false, running: false, connected: false },
          ],
        },
        channelDefaultAccountId: { quietchat: "default" },
      },
    );

    const displayState = resolveChannelDisplayState("quietchat", props);

    expect(displayState).toMatchObject({ configured: false, running: null, connected: null });
    expect(channelSnapshotEntryIsActive(props.channels.channelsSnapshot, "quietchat")).toBe(false);
  });
});

afterEach(() => {
  disposeChannelViews();
  document.body.replaceChildren();
});

describe("channel pairing", () => {
  const pairingProps = (overrides: ChannelsViewTestOverrides = {}): ChannelsProps =>
    createChannelsViewProps(null, pairingSnapshot(), overrides);

  function renderInto(
    props: ChannelsProps = pairingProps(),
    component: (props: ChannelsProps) => JSX.Element = renderChannelPairingQueue,
  ) {
    const container = document.createElement("div");
    document.body.append(container);
    renderChannelView(component, props, container);
    return container;
  }

  const button = (container: HTMLElement, label: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === label,
    )!;

  it("renders pending senders and keeps dismissal current across refresh", () => {
    const onDismiss = vi.fn();
    const props = pairingProps({ onPairingDismiss: onDismiss });
    const container = renderInto(props);

    expect(container.textContent).toContain("+15551234567");
    expect(container.textContent).toContain("Alice");
    const dismiss = button(container, "Dismiss");
    dismiss.click();
    expect(onDismiss).toHaveBeenCalledWith(request);

    const refreshed = { ...request, metadata: { name: "Alice Updated" } };
    props.channels.pairingSnapshot = {
      ...props.channels.pairingSnapshot!,
      requests: [refreshed],
    };
    renderChannelView(renderChannelPairingQueue, props, container);
    expect(container.textContent).toContain("Alice Updated");
    expect(container.contains(dismiss)).toBe(true);
    dismiss.click();
    expect(onDismiss).toHaveBeenLastCalledWith(refreshed);
  });

  it("hides cached sender data without pairing access", () => {
    const container = renderInto(pairingProps({ canManagePairing: false }));

    expect(container.textContent).toContain("operator.pairing access");
    expect(text(container, ".settings-status--warn")).toContain("operator.pairing access");
    expect(container.querySelector(".callout")).toBeNull();
    expect(container.textContent).not.toContain("+15551234567");
    expect(container.textContent).not.toContain("Alice");
  });

  it("renders notice and error feedback as status rows without nested callouts", () => {
    const props = pairingProps({
      pairingNotice: "Request approved",
      channels: { pairingError: "Approval failed" },
    });
    const container = renderInto(props);
    const selector = '.channels-pairing-feedback[role="status"]';
    const notice = container.querySelector(selector);

    expect(notice?.textContent).toContain("Request approved");
    expect(text(container, '.channels-pairing-feedback[role="alert"]')).toContain(
      "Approval failed",
    );
    expect(container.querySelector(".callout")).toBeNull();
    props.pairingNotice = "Request dismissed";
    renderChannelView(renderChannelPairingQueue, props, container);
    expect(container.querySelector(selector)).toBe(notice);
    expect(notice?.textContent).toContain("Request dismissed");
    props.pairingNotice = null;
    renderChannelView(renderChannelPairingQueue, props, container);
    expect(container.querySelector(selector)).toBeNull();
  });

  it("uses the channel picker and clears the account filter when the channel changes", async () => {
    const onPairingFilterChange = vi.fn();
    const props = pairingProps({
      pairingChannelFilter: "whatsapp",
      pairingAccountFilter: "personal",
      onPairingFilterChange,
    });
    props.channels.pairingSnapshot!.accounts.push({
      ...personal,
      channel: "telegram",
      channelLabel: "Telegram",
      accountId: "work",
      accountLabel: "Work",
    });
    const container = renderInto(props);
    await updatePickers(container);
    const selects = container.querySelectorAll<SelectPicker>("openclaw-select-picker");
    const channel = selects.item(0);
    const account = selects.item(1);
    expect(selects).toHaveLength(2);
    expect(container.querySelectorAll("select.settings-select")).toHaveLength(0);
    await openPicker(account);
    expect(
      account.querySelector('[role="option"][aria-selected="true"]')?.getAttribute("data-value"),
    ).toBe("personal");
    await choosePickerValue(channel, "telegram");
    expect(onPairingFilterChange).toHaveBeenCalledWith("telegram", null);
  });

  it("disables every request action while one mutation is active", () => {
    const props = pairingProps({ channels: { pairingBusyRequestId: request.requestId } });
    props.channels.pairingSnapshot!.requests.push({
      ...request,
      requestId: "other-request",
      senderId: "987654321",
    });
    const container = renderInto(props);
    const actions = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Approve "], button[aria-label^="Dismiss "]',
    );
    expect(Array.from(actions, (action) => action.disabled)).toEqual([true, true, true, true]);
  });

  it("shows explicit notification and first-owner choices for an admin", () => {
    const container = renderInto(
      pairingProps({
        pairingPrompt: {
          kind: "approve",
          request,
          notify: false,
          bootstrapCommandOwner: false,
        },
      }),
      renderChannelPairingPrompt,
    );

    expect(container.textContent).toContain("Notify the requester after approval");
    expect(container.textContent).toContain("Also make this sender the first command owner");
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it("links a channel account detail back to the filtered request queue", () => {
    const review = vi.fn();
    const props = pairingProps({ onPairingReviewAccount: review });
    const detail = (current: ChannelsProps) => renderChannelPairingDetail("whatsapp", current);
    const container = renderInto(props, detail);

    expect(container.textContent).toContain("1 pending");
    const reviewButton = button(container, "Review requests");
    reviewButton.click();
    expect(review).toHaveBeenCalledWith("whatsapp", "personal");

    props.channels.pairingSnapshot = {
      ...props.channels.pairingSnapshot!,
      accounts: structuredClone(props.channels.pairingSnapshot!.accounts),
      requests: [],
    };
    renderChannelView(detail, props, container);
    expect(container.querySelector("button")).toBe(reviewButton);
    expect(container.textContent).toContain("No pending requests");
    expect(container.textContent).not.toContain("1 pending");
  });
});
