import { html, render } from "lit";
import { brandIcons } from "../components/brand-icons.ts";
import { renderCopyButton } from "../components/copy-button.ts";
import { icons } from "../components/icons.ts";
import { kbdStyles } from "../components/kbd-styles.ts";
import { renderKbd, renderKeyboardShortcut } from "../components/kbd.ts";
import { renderAgentStartupState, renderLazyViewError } from "../components/lazy-view-error.ts";
import { renderConnectingSplash } from "../components/loading-skeleton.ts";
import { renderLoadingState } from "../components/loading-state.ts";
import { renderPanelEmptyState } from "../components/panel-empty-state.ts";
import { renderPanelIconButton } from "../components/panel-icon-button.ts";
import {
  renderPanelLoadingSkeleton,
  type PanelLoadingSkeletonVariant,
} from "../components/panel-loading-skeleton.ts";
import { renderPanelRefreshStatus } from "../components/panel-refresh-status.ts";
import {
  renderProviderBrandIcon,
  renderProviderFallbackIcon,
  resolveCloudProfileIcon,
} from "../components/provider-icon.ts";
import * as settings from "../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../components/settings-workspace.ts";
import { finishFixture, group, recordAction, root } from "./presentation-primitives-fixture.ts";

const keyboardStyles = document.createElement("style");
keyboardStyles.textContent = kbdStyles.cssText;
document.head.append(keyboardStyles);
let checked = false;
let segment = "balanced";
const options = [
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "disabled", label: "Unavailable", disabled: true },
];
const button = (label: string, action = label) =>
  html`<button class="btn" @click=${() => recordAction(action)}>${label}</button>`;
function card(label: string, content: unknown, kind = "") {
  return html`<section class="presentation-fixture__card" data-example=${label}>
    <h2>${label}</h2>
    <div class=${`presentation-fixture__body${kind ? ` presentation-fixture__body--${kind}` : ""}`}>
      ${content}
    </div>
  </section>`;
}
function settingsPage() {
  return settings.renderSettingsPage(
    [
      settings.renderSettingsPageHeader({
        title: "Presentation settings",
        subtitle: "Shared settings layout and controls.",
        actions: button("Save"),
      }),
      settings.renderSettingsSummary([
        { label: "Enabled", value: 3 },
        { label: "Available", value: 12 },
      ]),
      settings.renderSettingsSection(
        {
          title: "General",
          description: "A longer section description that wraps on narrow screens.",
          count: 3,
          actions: button("Add"),
          notice: html`<div class="callout info">Changes apply to this device.</div>`,
        },
        [
          settings.renderSettingsRow({
            title: "Workspace",
            description: "The active local workspace.",
            control: settings.renderSettingsValue("Personal", { mono: true }),
          }),
          settings.renderSettingsNavRow({
            title: "Advanced",
            description: "Open additional preferences.",
            onClick: () => recordAction("advanced"),
          }),
          settings.renderSettingsRow({
            title: "Wrapping control",
            description: "This field moves below its description on a phone.",
            stackedOnNarrow: true,
            control: html`<input
              class="settings-input"
              aria-label="Workspace name"
              value="A long workspace name"
            />`,
          }),
        ],
      ),
      settings.renderSettingsSection(
        { title: "Service status", carapace: true },
        (["ok", "warn", "danger", "accent", "muted"] as const).map((kind) =>
          settings.renderSettingsRow({
            title: kind,
            carapace: true,
            control: settings.renderSettingsStatus({ kind, label: kind, carapace: true }),
          }),
        ),
      ),
      settings.renderSettingsSection(
        { title: "Danger zone", danger: true },
        settings.renderSettingsRow({
          title: "Reset preferences",
          description: "Only this synthetic workspace is affected.",
          control: button("Reset"),
        }),
      ),
      settings.renderSettingsEmpty("No additional settings"),
      settings.renderSettingsLoadingSkeleton({
        label: "Loading settings",
        rows: 2,
        carapace: true,
      }),
    ],
    { wide: true },
  );
}
function controls() {
  return settings.renderSettingsPage(
    settings.renderSettingsSection(
      {
        title: "Controlled inputs",
        description: "Accepted, rejected, disabled, and keyboard-driven choices.",
      },
      [
        settings.renderSettingsToggleRow({
          title: "Accept toggle",
          description: "A whole-row activation changes this setting.",
          checked,
          onChange: (next) => {
            checked = next;
            draw();
            recordAction(`toggle:${next}`);
          },
        }),
        settings.renderSettingsRow({
          title: "Rejected toggle",
          control: settings.renderSettingsToggle({
            ariaLabel: "Rejected toggle",
            checked: false,
            onChange: () => {
              recordAction("toggle:rejected");
              return false;
            },
          }),
        }),
        settings.renderSettingsToggleRow({
          title: "Disabled toggle",
          checked: true,
          disabled: true,
          onChange: () => recordAction("unexpected"),
        }),
        settings.renderSettingsRow({
          title: "Quality",
          stackedOnNarrow: true,
          control: settings.renderSettingsSegmented({
            value: segment,
            ariaLabel: "Quality",
            options,
            onChange: (next) => {
              segment = next;
              draw();
              recordAction(`quality:${next}`);
            },
          }),
        }),
        settings.renderSettingsRow({
          title: "Rejected quality",
          control: settings.renderSettingsSegmented({
            value: "balanced",
            ariaLabel: "Rejected quality",
            options,
            onChange: () => {
              recordAction("quality:rejected");
              return false;
            },
          }),
        }),
        settings.renderSettingsRow({
          title: "Disabled quality",
          control: settings.renderSettingsSegmented({
            value: "balanced",
            ariaLabel: "Disabled quality",
            options,
            disabled: true,
            onChange: () => recordAction("unexpected"),
          }),
        }),
        settings.renderSettingsRow({
          title: "Button choices",
          control: settings.renderSettingsSegmented({
            value: segment,
            mode: "buttons",
            variant: "accent",
            ariaLabel: "Button choices",
            options,
            onChange: (next) => {
              segment = next;
              draw();
            },
          }),
        }),
      ],
    ),
  );
}
function feedback() {
  return [
    card(
      "Empty with action",
      renderPanelEmptyState({
        icon: icons.folder,
        heading: "No files",
        description: "Add a file to begin working in this panel.",
        action: button("Add file", "add-file"),
      }),
      "empty",
    ),
    card(
      "Refresh stale",
      renderPanelRefreshStatus({
        status: { error: null, hasLoaded: true, stale: true, awaitingGateway: false },
      }),
    ),
    card(
      "Refresh failed",
      renderPanelRefreshStatus({
        status: {
          error: "Synthetic refresh failure",
          hasLoaded: true,
          stale: true,
          awaitingGateway: false,
        },
      }),
    ),
    card(
      "Lazy error",
      renderLazyViewError({
        error: new Error("Synthetic module failure"),
        subtitle: "Files could not open.",
        onRetry: () => recordAction("retry"),
        onClose: () => recordAction("close"),
      }),
    ),
    card(
      "Stale module",
      renderLazyViewError({
        error: new Error("Synthetic stale module"),
        stale: true,
        onRetry: () => recordAction("reload"),
      }),
    ),
    card(
      "Inline error",
      renderLazyViewError({
        error: "Synthetic inline error",
        render: () => html`<p>Existing panel content remains visible.</p>`,
        onRetry: () => recordAction("inline-retry"),
      }),
    ),
    card(
      "Actions and shortcuts",
      html`<div class="presentation-fixture__inline">
        ${renderCopyButton("synthetic clipboard text", "Copy text")}${renderCopyButton("", "Copy unavailable text")}${renderPanelIconButton({ label: "Refresh panel", icon: icons.refresh, className: "btn btn--icon", onClick: () => recordAction("refresh") })}${renderPanelIconButton({ label: "Busy panel", icon: icons.refresh, className: "btn btn--icon", onClick: () => recordAction("unexpected"), disabled: true, busy: true })}${renderKbd(["⌘", "↵"])}${renderKeyboardShortcut({ key: "k", modifiers: ["mod"] }, { applePlatform: false })}
      </div>`,
    ),
  ];
}
function iconGallery() {
  const names = [
    "copy",
    "check",
    "info",
    "refresh",
    "alertTriangle",
    "folder",
    "mark",
    "lobster",
    "github",
  ] as const;
  return card(
    "Icon families",
    html`<div class="presentation-fixture__icons">
      ${names.map((name) => html`<div>${icons[name]}<span>${name}</span></div>`)}
      ${Object.entries(brandIcons).map(([name, svg]) => html`<div>${svg}<span>${name}</span></div>`)}
      ${["google", "acp-copilot", "anthropic", "unknown"].map((provider) => html`<div>${renderProviderBrandIcon(provider)}<span>${provider}</span></div>`)}
      <div>${renderProviderFallbackIcon("👨‍👩‍👧‍👦")}<span>Emoji fallback</span></div>
      <div>${resolveCloudProfileIcon({ providerId: "google" }).icon}<span>Cloud profile</span></div>
    </div>`,
  );
}
function skeletons() {
  const variants: PanelLoadingSkeletonVariant[] =
    group === "skeleton-structure"
      ? ["board", "browser", "desktop"]
      : group === "skeleton-content"
        ? ["files", "file-list", "document", "review"]
        : ["chat", "discussion", "terminal"];
  return [
    variants.map((variant) =>
      card(variant, renderPanelLoadingSkeleton(variant, `Loading ${variant}`), "panel"),
    ),
    group === "skeleton-conversation"
      ? [
          card("compact", renderPanelLoadingSkeleton("terminal", "Loading compact terminal", true)),
          card(
            "overlay",
            html`<p>Retained content</p>
              ${renderPanelLoadingSkeleton("files", "Refreshing files", false, true)}`,
            "panel",
          ),
        ]
      : undefined,
  ];
}
function draw() {
  const content =
    group === "settings"
      ? renderSettingsWorkspace(settingsPage())
      : group === "controls"
        ? controls()
        : group === "feedback"
          ? feedback()
          : group === "icons"
            ? iconGallery()
            : group === "loading"
              ? [
                  card("Loading route", renderLoadingState(), "loading"),
                  card("Connecting", renderConnectingSplash("Connecting to Gateway"), "loading"),
                  card("Starting agent", renderAgentStartupState()),
                ]
              : skeletons();
  render(
    html`<h1>${group}</h1>
      <div
        class=${group === "settings" || group === "controls" ? "" : "presentation-fixture__grid"}
      >
        ${content}
      </div>`,
    root,
  );
}
draw();
finishFixture();
