import { render, type JSX } from "@solidjs/web";
import { createSignal, For } from "solid-js";
import { CopyButton } from "../components/solid/copy-button.tsx";
import { BrandIcon, Icon } from "../components/solid/icon.tsx";
import { Kbd, KeyboardShortcut } from "../components/solid/kbd.tsx";
import { AgentStartupState, LazyViewError } from "../components/solid/lazy-view-error.tsx";
import { ConnectingSplash } from "../components/solid/loading-skeleton.tsx";
import { LoadingState } from "../components/solid/loading-state.tsx";
import { PanelEmptyState } from "../components/solid/panel-empty-state.tsx";
import { PanelIconButton } from "../components/solid/panel-icon-button.tsx";
import {
  PanelLoadingSkeleton,
  type PanelLoadingSkeletonVariant,
} from "../components/solid/panel-loading-skeleton.tsx";
import { PanelRefreshStatus } from "../components/solid/panel-refresh-status.tsx";
import {
  CloudProfileIcon,
  ProviderBrandIcon,
  ProviderFallbackIcon,
} from "../components/solid/provider-icon.tsx";
import * as settings from "../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../components/solid/settings-workspace.tsx";
import { finishFixture, group, recordAction, root } from "./presentation-primitives-fixture.ts";

const options = [
  { value: "fast", label: "Fast" },
  { value: "balanced", label: "Balanced" },
  { value: "disabled", label: "Unavailable", disabled: true },
];
function Button(props: { label: string; action?: string }) {
  return (
    <button class="btn" onClick={() => recordAction(props.action ?? props.label)}>
      {props.label}
    </button>
  );
}
function Card(props: { label: string; kind?: string; children: JSX.Element }) {
  return (
    <section class="presentation-fixture__card" data-example={props.label}>
      <h2>{props.label}</h2>
      <div
        class={[
          "presentation-fixture__body",
          { [`presentation-fixture__body--${props.kind}`]: Boolean(props.kind) },
        ]}
      >
        {props.children}
      </div>
    </section>
  );
}
function SettingsPage() {
  return (
    <SettingsWorkspace>
      <settings.SettingsPage wide>
        <settings.SettingsPageHeader
          title="Presentation settings"
          subtitle="Shared settings layout and controls."
          actions={<Button label="Save" />}
        />
        <settings.SettingsSummary
          items={[
            { label: "Enabled", value: 3 },
            { label: "Available", value: 12 },
          ]}
        />
        <settings.SettingsSection
          title="General"
          description="A longer section description that wraps on narrow screens."
          count={3}
          actions={<Button label="Add" />}
          notice={<div class="callout info">Changes apply to this device.</div>}
        >
          <settings.SettingsRow
            title="Workspace"
            description="The active local workspace."
            control={<settings.SettingsValue value="Personal" mono />}
          />
          <settings.SettingsNavRow
            title="Advanced"
            description="Open additional preferences."
            onClick={() => recordAction("advanced")}
          />
          <settings.SettingsRow
            title="Wrapping control"
            description="This field moves below its description on a phone."
            stackedOnNarrow
            control={
              <input
                class="settings-input"
                aria-label="Workspace name"
                value="A long workspace name"
              />
            }
          />
        </settings.SettingsSection>
        <settings.SettingsSection title="Service status" carapace>
          <For each={["ok", "warn", "danger", "accent", "muted"] as const}>
            {(kind) => (
              <settings.SettingsRow
                title={kind}
                carapace
                control={<settings.SettingsStatus kind={kind} label={kind} carapace />}
              />
            )}
          </For>
        </settings.SettingsSection>
        <settings.SettingsSection title="Danger zone" danger>
          <settings.SettingsRow
            title="Reset preferences"
            description="Only this synthetic workspace is affected."
            control={<Button label="Reset" />}
          />
        </settings.SettingsSection>
        <settings.SettingsEmpty message="No additional settings" />
        <settings.SettingsLoadingSkeleton label="Loading settings" rows={2} carapace />
      </settings.SettingsPage>
    </SettingsWorkspace>
  );
}
function Controls() {
  const [checked, setChecked] = createSignal(false);
  const [segment, setSegment] = createSignal("balanced");
  const [visible, setVisible] = createSignal(false);
  const [secret, setSecret] = createSignal("synthetic-token");
  return (
    <settings.SettingsPage>
      <settings.SettingsSection
        title="Controlled inputs"
        description="Accepted, rejected, disabled, and keyboard-driven choices."
      >
        <settings.SettingsToggleRow
          title="Accept toggle"
          description="A whole-row activation changes this setting."
          checked={checked()}
          onChange={(next) => {
            setChecked(next);
            recordAction(`toggle:${next}`);
          }}
        />
        <settings.SettingsRow
          title="Rejected toggle"
          control={
            <settings.SettingsToggle
              ariaLabel="Rejected toggle"
              checked={false}
              onChange={() => {
                recordAction("toggle:rejected");
                return false;
              }}
            />
          }
        />
        <settings.SettingsToggleRow
          title="Disabled toggle"
          checked
          disabled
          onChange={() => recordAction("unexpected")}
        />
        <settings.SettingsRow
          title="Quality"
          stackedOnNarrow
          control={
            <settings.SettingsSegmented
              value={segment()}
              ariaLabel="Quality"
              options={options}
              onChange={(next) => {
                setSegment(next);
                recordAction(`quality:${next}`);
              }}
            />
          }
        />
        <settings.SettingsRow
          title="Rejected quality"
          control={
            <settings.SettingsSegmented
              value="balanced"
              ariaLabel="Rejected quality"
              options={options}
              onChange={() => {
                recordAction("quality:rejected");
                return false;
              }}
            />
          }
        />
        <settings.SettingsRow
          title="Disabled quality"
          control={
            <settings.SettingsSegmented
              value="balanced"
              ariaLabel="Disabled quality"
              options={options}
              disabled
              onChange={() => recordAction("unexpected")}
            />
          }
        />
        <settings.SettingsRow
          title="Button choices"
          control={
            <settings.SettingsSegmented
              value={segment()}
              mode="buttons"
              variant="accent"
              ariaLabel="Button choices"
              options={options}
              onChange={setSegment}
            />
          }
        />
        <settings.SettingsRow
          title="Secret"
          control={
            <settings.SettingsSecretInput
              ariaLabel="Secret"
              value={secret()}
              visible={visible()}
              showLabel="Show secret"
              hideLabel="Hide secret"
              toggleLabel="Toggle secret"
              onInput={setSecret}
              onToggle={() => setVisible(!visible())}
            />
          }
        />
      </settings.SettingsSection>
    </settings.SettingsPage>
  );
}
function Feedback() {
  return (
    <>
      <Card label="Empty with action" kind="empty">
        <PanelEmptyState
          icon={<Icon name="folder" />}
          heading="No files"
          description="Add a file to begin working in this panel."
          action={<Button label="Add file" action="add-file" />}
        />
      </Card>
      <Card label="Refresh stale">
        <PanelRefreshStatus
          status={{ error: null, hasLoaded: true, stale: true, awaitingGateway: false }}
        />
      </Card>
      <Card label="Refresh failed">
        <PanelRefreshStatus
          status={{
            error: "Synthetic refresh failure",
            hasLoaded: true,
            stale: true,
            awaitingGateway: false,
          }}
        />
      </Card>
      <Card label="Lazy error">
        <LazyViewError
          error={new Error("Synthetic module failure")}
          subtitle="Files could not open."
          onRetry={() => recordAction("retry")}
          onClose={() => recordAction("close")}
        />
      </Card>
      <Card label="Stale module">
        <LazyViewError
          error={new Error("Synthetic stale module")}
          stale
          onRetry={() => recordAction("reload")}
        />
      </Card>
      <Card label="Inline error">
        <LazyViewError
          error="Synthetic inline error"
          render={() => <p>Existing panel content remains visible.</p>}
          onRetry={() => recordAction("inline-retry")}
        />
      </Card>
      <Card label="Actions and shortcuts">
        <div class="presentation-fixture__inline">
          <CopyButton text="synthetic clipboard text" idleLabel="Copy text" />
          <CopyButton text="" idleLabel="Copy unavailable text" />
          <PanelIconButton
            label="Refresh panel"
            icon={<Icon name="refresh" />}
            class="btn btn--icon"
            onClick={() => recordAction("refresh")}
          />
          <PanelIconButton
            label="Busy panel"
            icon={<Icon name="refresh" />}
            class="btn btn--icon"
            onClick={() => recordAction("unexpected")}
            disabled
            busy
          />
          <Kbd keys={["⌘", "↵"]} />
          <KeyboardShortcut combo={{ key: "k", modifiers: ["mod"] }} applePlatform={false} />
        </div>
      </Card>
    </>
  );
}
function Icons() {
  return (
    <Card label="Icon families">
      <div class="presentation-fixture__icons">
        <For
          each={
            [
              "copy",
              "check",
              "info",
              "refresh",
              "alertTriangle",
              "folder",
              "mark",
              "lobster",
              "github",
            ] as const
          }
        >
          {(name) => (
            <div>
              <Icon name={name} />
              <span>{name}</span>
            </div>
          )}
        </For>
        <For each={["github", "reddit", "discord", "x"] as const}>
          {(name) => (
            <div>
              <BrandIcon name={name} />
              <span>{name}</span>
            </div>
          )}
        </For>
        <For each={["google", "acp-copilot", "anthropic", "unknown"]}>
          {(provider) => (
            <div>
              <ProviderBrandIcon provider={provider} />
              <span>{provider}</span>
            </div>
          )}
        </For>
        <div>
          <ProviderFallbackIcon label="👨‍👩‍👧‍👦" />
          <span>Emoji fallback</span>
        </div>
        <div>
          <CloudProfileIcon profile={{ providerId: "google" }} />
          <span>Cloud profile</span>
        </div>
      </div>
    </Card>
  );
}
function Skeletons() {
  const variants: PanelLoadingSkeletonVariant[] =
    group === "skeleton-structure"
      ? ["board", "browser", "desktop"]
      : group === "skeleton-content"
        ? ["files", "file-list", "document", "review"]
        : ["chat", "discussion", "terminal"];
  return (
    <>
      <For each={variants}>
        {(variant) => (
          <Card label={variant} kind="panel">
            <PanelLoadingSkeleton variant={variant} label={`Loading ${variant}`} />
          </Card>
        )}
      </For>
      {group === "skeleton-conversation" ? (
        <>
          <Card label="compact">
            <PanelLoadingSkeleton variant="terminal" label="Loading compact terminal" compact />
          </Card>
          <Card label="overlay" kind="panel">
            <p>Retained content</p>
            <PanelLoadingSkeleton variant="files" label="Refreshing files" overlay />
          </Card>
        </>
      ) : undefined}
    </>
  );
}
function Gallery() {
  return (
    <>
      <h1>{group}</h1>
      <div class={group === "settings" || group === "controls" ? "" : "presentation-fixture__grid"}>
        {group === "settings" ? (
          <SettingsPage />
        ) : group === "controls" ? (
          <Controls />
        ) : group === "feedback" ? (
          <Feedback />
        ) : group === "icons" ? (
          <Icons />
        ) : group === "loading" ? (
          <>
            <Card label="Loading route" kind="loading">
              <LoadingState />
            </Card>
            <Card label="Connecting" kind="loading">
              <ConnectingSplash status="Connecting to Gateway" />
            </Card>
            <Card label="Starting agent">
              <AgentStartupState />
            </Card>
          </>
        ) : (
          <Skeletons />
        )}
      </div>
    </>
  );
}
const dispose = render(() => <Gallery />, root);
window.addEventListener("pagehide", dispose, { once: true });
finishFixture();
