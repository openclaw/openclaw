import { createSignal, onCleanup } from "@solidjs/signals";
import { For, Show } from "solid-js";
import { deviceSettingsGroupLabelKey } from "../../app-navigation.ts";
import type {
  NativeDeviceSettingsCapability,
  NativeDeviceSettingsSnapshot,
  SettingKey,
} from "../../app/native-device-settings.ts";
import {
  LearnMoreLink,
  SettingsEmpty,
  SettingsPage,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsToggleRow,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { SettingsWorkspace } from "../../components/solid/settings-workspace.tsx";
import { registerAppsEnglish } from "../../i18n/locales/en-apps.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { projectNativeDeviceSettings } from "../../lib/reactive/application-native.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { liveValue } from "../../lib/reactive/live-value.ts";
import { defineSolidBridge } from "../../lit/solid-bridge.ts";
import "../../components/native-chrome-setup.ts";
import "./device.css";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-native-chrome-setup": HTMLAttributes<HTMLElement>;
    }
  }
}

registerEnglishCatalog(registerAppsEnglish);
registerEnglishCatalog(registerSettingsEnglish);
type CookieSyncEdits = {
  domains: string[] | null;
  targetProfile: { value: string; sent: boolean } | null;
};

const pendingCookieSyncEdits = new WeakMap<NativeDeviceSettingsCapability, CookieSyncEdits>();

function retainCookieSyncEdits(capability: NativeDeviceSettingsCapability): CookieSyncEdits {
  let edits = pendingCookieSyncEdits.get(capability);
  if (!edits) {
    edits = { domains: null, targetProfile: null };
    pendingCookieSyncEdits.set(capability, edits);
  }
  return edits;
}

function settleCookieSyncEdit(
  capability: NativeDeviceSettingsCapability,
  key: keyof CookieSyncEdits,
  edit: CookieSyncEdits[keyof CookieSyncEdits],
) {
  const edits = pendingCookieSyncEdits.get(capability);
  if (!edits || edits[key] !== edit) {
    return;
  }
  // Completion belongs to this exact edit, including Cancel and native normalization.
  // A newer edit can have the same value and must survive the older reply.
  edits[key] = null;
  if (edits.domains === null && edits.targetProfile === null) {
    pendingCookieSyncEdits.delete(capability);
  }
}

function DevicePageContent() {
  const capability = useApplication().nativeDeviceSettings;
  const projection = capability ? projectNativeDeviceSettings(capability) : null;
  const snapshot = () => projection?.read();
  const [newDomain, setNewDomain] = createSignal("");
  const [editRevision, setEditRevision] = createSignal(0);
  const [gatewayHostingEdit, setGatewayHostingEdit] = createSignal<{
    pending: boolean;
    error?: Error;
  } | null>(null);
  let gatewayHostingRequest = 0;
  let targetProfileTimer: ReturnType<typeof setTimeout> | null = null;

  const pendingEdits = () => {
    projection?.revision();
    editRevision();
    return capability ? pendingCookieSyncEdits.get(capability) : undefined;
  };
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    flushTargetProfile();
  });
  const invalidateEdits = () => {
    if (!disposed) {
      setEditRevision((revision) => revision + 1);
    }
  };
  function flushTargetProfile() {
    const pending = targetProfileTimer;
    if (pending === null || !capability) {
      return;
    }
    clearTimeout(pending);
    targetProfileTimer = null;
    const profile = pendingCookieSyncEdits.get(capability)?.targetProfile;
    if (profile && !profile.sent) {
      profile.sent = true;
      capability.set("browser.cookieSync.targetProfile", profile.value, () => {
        settleCookieSyncEdit(capability, "targetProfile", profile);
        invalidateEdits();
      });
    }
  }
  function editTargetProfile(value: string) {
    if (!capability) {
      return;
    }
    if (targetProfileTimer) {
      clearTimeout(targetProfileTimer);
    }
    retainCookieSyncEdits(capability).targetProfile = { value, sent: false };
    targetProfileTimer = setTimeout(flushTargetProfile, 400);
    invalidateEdits();
  }
  function updateDomains(update: (domains: string[]) => string[]) {
    if (!capability) {
      return;
    }
    const domains =
      pendingCookieSyncEdits.get(capability)?.domains ??
      capability.snapshot?.browser?.cookieSync?.domains;
    if (!domains) {
      return;
    }
    const values = [
      ...new Set(
        update(domains)
          .map((domain) => domain.trim().toLowerCase())
          .filter(Boolean),
      ),
    ];
    retainCookieSyncEdits(capability).domains = values;
    invalidateEdits();
    capability.set("browser.cookieSync.domains", values, () => {
      settleCookieSyncEdit(capability, "domains", values);
      invalidateEdits();
    });
  }

  function Toggle(props: {
    setting: SettingKey;
    checked: boolean | undefined;
    label: string;
    description?: string;
    disabled?: boolean;
  }) {
    return (
      <Show when={props.checked !== undefined}>
        <SettingsToggleRow
          title={t(`configPage.deviceSettings.${props.label}`)}
          description={props.description}
          checked={props.checked ?? false}
          disabled={props.disabled}
          onChange={(value) => capability?.set(props.setting, value)}
        />
      </Show>
    );
  }
  function Select(props: {
    setting: "app.appearance" | "app.iconStyle" | "capabilities.computerControlProvider";
    value: string;
    options: Array<{ id: string; name: string; disabled?: boolean }>;
    description?: string;
    disabled?: boolean;
  }) {
    const title = () =>
      t(`configPage.deviceSettings.${props.setting.slice(props.setting.indexOf(".") + 1)}`);
    return (
      <SettingsRow
        title={title()}
        description={props.description}
        control={
          <select
            class="settings-select"
            aria-label={title()}
            ref={liveValue(() => props.value)}
            disabled={props.disabled}
            onChange={(event) => capability?.set(props.setting, event.currentTarget.value)}
          >
            <For each={props.options} keyed={(option) => option.id}>
              {(_option, index) => (
                <option
                  value={props.options[index()]!.id}
                  selected={props.options[index()]!.id === props.value}
                  disabled={props.options[index()]!.disabled}
                >
                  {props.options[index()]!.name}
                </option>
              )}
            </For>
          </select>
        }
      />
    );
  }
  function GatewayHosting(props: { app: NonNullable<NativeDeviceSettingsSnapshot["app"]> }) {
    const edit = gatewayHostingEdit;
    return (
      <Show when={props.app.keepGatewayRunning !== undefined && capability}>
        <SettingsToggleRow
          title={t("configPage.deviceSettings.keepGatewayRunning")}
          description={
            <>
              {t("configPage.deviceSettings.keepGatewayRunningHint")}
              <Show when={edit()?.error}>
                {(error) => (
                  <>
                    <br />
                    <span role="alert">
                      {t("configPage.deviceSettings.keepGatewayRunningFailed")} {error().message}
                    </span>
                  </>
                )}
              </Show>
            </>
          }
          checked={props.app.keepGatewayRunning ?? false}
          disabled={props.app.keepGatewayRunningAvailable !== true || edit()?.pending === true}
          onChange={(value) => {
            if (!capability) {
              return;
            }
            const request = ++gatewayHostingRequest;
            setGatewayHostingEdit({ pending: true });
            capability.set("app.keepGatewayRunning", value, (error) => {
              if (!disposed && gatewayHostingRequest === request) {
                setGatewayHostingEdit({ pending: false, error });
              }
            });
          }}
        />
      </Show>
    );
  }
  function BrowserSettings(props: {
    browser: NonNullable<NativeDeviceSettingsSnapshot["browser"]>;
  }) {
    const sync = () => props.browser.cookieSync;
    const domains = () => pendingEdits()?.domains ?? sync()?.domains ?? [];
    return (
      <>
        <SettingsSection title={t("configPage.deviceSettings.chromeExtension")}>
          <SettingsRow
            title={t("configPage.deviceSettings.chromeExtensionSetup")}
            stacked
            control={
              <div class="device-extension-setup">
                <openclaw-native-chrome-setup auto-inspect />
                <div class="device-extension-setup__actions">
                  <a
                    href="https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("appsPage.ctaChromeWebStore")}
                  </a>
                  <LearnMoreLink url="https://docs.openclaw.ai/tools/chrome-extension" />
                </div>
              </div>
            }
          />
        </SettingsSection>
        <Show when={props.browser.importAvailable || (sync() && !sync()?.available)}>
          <SettingsSection title={t("configPage.deviceSettings.browser")}>
            <Show when={props.browser.importAvailable}>
              <SettingsRow
                title={t("configPage.deviceSettings.browserImport")}
                description={t("configPage.deviceSettings.browserImportHint")}
                control={
                  <button
                    type="button"
                    class="btn"
                    onClick={() => capability?.openPanel("browser-import")}
                  >
                    {t("configPage.deviceSettings.importBrowserLogins")}
                  </button>
                }
              />
            </Show>
            <Show when={sync() && !sync()?.available}>
              <SettingsRow
                title={t("configPage.deviceSettings.cookieSync")}
                description={t("configPage.deviceSettings.cookieSyncUnavailable")}
              />
            </Show>
          </SettingsSection>
        </Show>
        <Show when={sync()?.available}>
          <SettingsSection
            title={t(
              props.browser.importAvailable
                ? "configPage.deviceSettings.cookieSync"
                : "configPage.deviceSettings.browser",
            )}
            description={
              props.browser.importAvailable ? undefined : t("configPage.deviceSettings.cookieSync")
            }
          >
            <Toggle
              setting="browser.cookieSync.enabled"
              checked={sync()?.enabled}
              label="cookieSyncEnabled"
              description={t("configPage.deviceSettings.cookieSyncHint")}
            />
            <SettingsRow
              title={t("configPage.deviceSettings.domains")}
              description={t("configPage.deviceSettings.domainsHint")}
              stacked
              control={
                <div class="device-domains">
                  <For each={domains()} keyed={(domain) => domain}>
                    {(domain) => (
                      <div class="device-domain-entry">
                        <SettingsValue value={domain()} />
                        <button
                          type="button"
                          class="btn small"
                          aria-label={t("configPage.deviceSettings.removeDomain", {
                            domain: domain(),
                          })}
                          onClick={() =>
                            updateDomains((current) =>
                              current.filter((entry) => entry !== domain()),
                            )
                          }
                        >
                          {t("common.remove")}
                        </button>
                      </div>
                    )}
                  </For>
                  <form
                    class="device-domain-entry"
                    onSubmit={(event) => {
                      event.preventDefault();
                      updateDomains((current) => [...current, newDomain()]);
                      setNewDomain("");
                    }}
                  >
                    <input
                      type="text"
                      class="settings-input"
                      aria-label={t("configPage.deviceSettings.addDomain")}
                      ref={liveValue(newDomain)}
                      onInput={(event) => setNewDomain(event.currentTarget.value)}
                    />
                    <button type="submit" class="btn" disabled={!newDomain().trim()}>
                      {t("configPage.deviceSettings.addDomain")}
                    </button>
                  </form>
                </div>
              }
            />
            <SettingsRow
              title={t("configPage.deviceSettings.targetProfile")}
              description={t("configPage.deviceSettings.targetProfileHint")}
              control={
                <input
                  type="text"
                  class="settings-input"
                  aria-label={t("configPage.deviceSettings.targetProfile")}
                  ref={liveValue(
                    () => pendingEdits()?.targetProfile?.value ?? sync()?.targetProfile ?? "",
                  )}
                  onInput={(event) => editTargetProfile(event.currentTarget.value)}
                  onChange={flushTargetProfile}
                />
              }
            />
            <SettingsRow
              title={t("configPage.deviceSettings.syncStatus")}
              description={sync()?.detail ?? undefined}
              control={
                <SettingsStatus
                  kind={
                    sync()?.state === "error"
                      ? "danger"
                      : sync()?.state === "running"
                        ? "accent"
                        : "muted"
                  }
                  label={t(`configPage.deviceSettings.syncStates.${sync()?.state}`)}
                />
              }
            />
          </SettingsSection>
        </Show>
      </>
    );
  }
  function Settings(props: { snapshot: NativeDeviceSettingsSnapshot }) {
    return (
      <>
        <Show when={Boolean(props.snapshot.app)}>
          <SettingsSection title={t("configPage.deviceSettings.app")}>
            <Toggle
              setting="app.nativeExperienceEnabled"
              checked={props.snapshot.app!.nativeExperienceEnabled}
              label="nativeExperience"
              description={t("configPage.deviceSettings.nativeExperienceHint")}
            />
            <Show when={props.snapshot.app!.appearance !== undefined}>
              <Select
                setting="app.appearance"
                value={props.snapshot.app!.appearance ?? "system"}
                options={["system", "light", "dark"].map((value) => ({
                  id: value,
                  name: t(`configPage.deviceSettings.appearanceModes.${value}`),
                }))}
              />
            </Show>
            <Toggle
              setting="app.notificationsEnabled"
              checked={props.snapshot.app!.notificationsEnabled}
              label="notificationsEnabled"
              description={t("configPage.deviceSettings.notificationsEnabledHint")}
            />
            <Toggle
              setting="app.showDockIcon"
              checked={props.snapshot.app!.showDockIcon}
              label="showDockIcon"
              description={t("configPage.deviceSettings.showDockIconHint")}
            />
            <Show when={Boolean(props.snapshot.app!.iconStyle)}>
              <Select
                setting="app.iconStyle"
                value={props.snapshot.app!.iconStyle!.selectedId}
                options={props.snapshot.app!.iconStyle!.available}
                description={t("configPage.deviceSettings.iconStyleHint")}
                disabled={props.snapshot.app!.iconStyle!.available.length === 0}
              />
            </Show>
            <Toggle
              setting="app.iconAnimationsEnabled"
              checked={props.snapshot.app!.iconAnimationsEnabled}
              label="iconAnimations"
              description={t("configPage.deviceSettings.iconAnimationsHint")}
            />
            <Toggle
              setting="app.launchAtLogin"
              checked={props.snapshot.app!.launchAtLogin}
              label="launchAtLogin"
              description={
                props.snapshot.app!.launchAtLoginAvailable === false
                  ? t("configPage.deviceSettings.launchAtLoginUnavailable")
                  : undefined
              }
              disabled={props.snapshot.app!.launchAtLoginAvailable === false}
            />
            <GatewayHosting app={props.snapshot.app!} />
            <Toggle
              setting="app.quickChatEnabled"
              checked={props.snapshot.app!.quickChatEnabled}
              label="quickChat"
              description={t("configPage.deviceSettings.quickChatHint")}
            />
            <Show when={props.snapshot.app!.quickChatShortcut !== undefined}>
              <SettingsRow
                title={t("configPage.deviceSettings.quickChatShortcut")}
                control={
                  <>
                    <SettingsValue
                      value={
                        props.snapshot.app!.quickChatShortcut ??
                        t("configPage.deviceSettings.notSet")
                      }
                    />
                    <button
                      type="button"
                      class="btn"
                      onClick={() => capability?.openPanel("quick-chat-shortcut")}
                    >
                      {t("configPage.deviceSettings.changeShortcut")}
                    </button>
                  </>
                }
              />
            </Show>
          </SettingsSection>
        </Show>
        <Show when={Boolean(props.snapshot.capabilities)}>
          <SettingsSection title={t("configPage.deviceSettings.capabilities")}>
            <Toggle
              setting="capabilities.canvasEnabled"
              checked={props.snapshot.capabilities!.canvasEnabled}
              label="canvas"
              description={t("configPage.deviceSettings.canvasHint")}
            />
            <Toggle
              setting="capabilities.cameraEnabled"
              checked={props.snapshot.capabilities!.cameraEnabled}
              label="camera"
              description={t("configPage.deviceSettings.cameraHint")}
            />
            <Toggle
              setting="capabilities.keepAwakeEnabled"
              checked={props.snapshot.capabilities!.keepAwakeEnabled}
              label="keepAwake"
              description={t(
                props.snapshot.device.platform === "ios"
                  ? "configPage.deviceSettings.keepAwakeHint"
                  : "configPage.deviceSettings.keepAwakeComputerHint",
              )}
            />
            <Show when={props.snapshot.capabilities!.healthSummaryAvailable}>
              <Toggle
                setting="capabilities.healthSummaryEnabled"
                checked={props.snapshot.capabilities!.healthSummaryEnabled}
                label="healthSummary"
                description={t("configPage.deviceSettings.healthSummaryHint")}
              />
            </Show>
            <Toggle
              setting="capabilities.computerControlEnabled"
              checked={props.snapshot.capabilities!.computerControlEnabled}
              label="computerControl"
              description={t("configPage.deviceSettings.computerControlHint")}
            />
            <Toggle
              setting="capabilities.desktopSharingEnabled"
              checked={props.snapshot.capabilities!.desktopSharingEnabled}
              label="desktopSharing"
              description={t(
                props.snapshot.device.platform === "macos"
                  ? "configPage.deviceSettings.desktopSharingHint"
                  : "configPage.deviceSettings.desktopSharingComputerHint",
              )}
            />
            <Show when={Boolean(props.snapshot.desktopSharing)}>
              <SettingsRow
                title={t("configPage.deviceSettings.desktopSharingStatus")}
                description={props.snapshot.desktopSharing!.detail}
                control={
                  <SettingsStatus
                    kind={
                      props.snapshot.desktopSharing!.state === "error"
                        ? "danger"
                        : props.snapshot.desktopSharing!.state === "running"
                          ? "ok"
                          : "muted"
                    }
                    label={t(
                      `configPage.deviceSettings.desktopSharingStates.${props.snapshot.desktopSharing!.state}`,
                    )}
                  />
                }
              />
            </Show>
            <Toggle
              setting="capabilities.unattendedDesktopEnabled"
              checked={props.snapshot.capabilities!.unattendedDesktopEnabled}
              label="unattendedDesktop"
              description={t("configPage.deviceSettings.unattendedDesktopHint")}
            />
            <Show when={Boolean(props.snapshot.desktopAvailability)}>
              <SettingsRow
                title={t("configPage.deviceSettings.desktopAvailability")}
                control={
                  <SettingsStatus
                    kind={props.snapshot.desktopAvailability!.state === "unlocked" ? "ok" : "warn"}
                    label={t(
                      `configPage.deviceSettings.desktopStates.${props.snapshot.desktopAvailability!.state}`,
                    )}
                  />
                }
              />
            </Show>
            <Show
              when={
                props.snapshot.capabilities!.computerControlEnabled &&
                props.snapshot.capabilities!.computerControlProvider !== undefined
              }
            >
              <Select
                setting="capabilities.computerControlProvider"
                value={props.snapshot.capabilities!.computerControlProvider ?? "peekaboo"}
                options={[
                  { id: "peekaboo", name: t("configPage.deviceSettings.peekaboo") },
                  {
                    id: "cua",
                    name: t(
                      props.snapshot.capabilities!.cuaDriverBundled
                        ? "configPage.deviceSettings.cua"
                        : "configPage.deviceSettings.cuaUnavailable",
                    ),
                    disabled: !props.snapshot.capabilities!.cuaDriverBundled,
                  },
                ]}
              />
            </Show>
            <Toggle
              setting="capabilities.peekabooBridgeEnabled"
              checked={props.snapshot.capabilities!.peekabooBridgeEnabled}
              label="peekabooBridge"
              description={t("configPage.deviceSettings.peekabooBridgeHint")}
              disabled={!props.snapshot.capabilities!.computerControlEnabled}
            />
          </SettingsSection>
        </Show>
        <Show when={Boolean(props.snapshot.browser)}>
          <BrowserSettings browser={props.snapshot.browser!} />
        </Show>
        <Show when={props.snapshot.app?.debugPaneEnabled !== undefined}>
          <SettingsSection title={t("configPage.deviceSettings.developer")}>
            <Toggle
              setting="app.debugPaneEnabled"
              checked={props.snapshot.app?.debugPaneEnabled}
              label="debugTools"
            />
            <Show when={props.snapshot.app?.debugPaneEnabled}>
              <SettingsRow
                title={t("configPage.deviceSettings.debugWindow")}
                control={
                  <button type="button" class="btn" onClick={() => capability?.openPanel("debug")}>
                    {t("configPage.deviceSettings.openDebug")}
                  </button>
                }
              />
            </Show>
          </SettingsSection>
        </Show>
        <Show when={props.snapshot.device.platform === "ios"}>
          <SettingsSection title={t("configPage.deviceSettings.device")}>
            <For
              each={["diagnostics", "licenses", "about", "watch"] as const}
              keyed={(panel) => panel}
            >
              {(panel) => (
                <SettingsRow
                  title={t(`configPage.deviceSettings.panels.${panel()}`)}
                  control={
                    <button
                      type="button"
                      class="btn"
                      onClick={() => capability?.openPanel(panel())}
                    >
                      {t("configPage.deviceSettings.openPanel")}
                    </button>
                  }
                />
              )}
            </For>
          </SettingsSection>
        </Show>
      </>
    );
  }
  return (
    <>
      <SettingsPageHeader
        title={t(deviceSettingsGroupLabelKey(snapshot()))}
        subtitle={
          <>
            {t(
              snapshot()?.device.platform === "macos"
                ? "configPage.deviceSettings.intro"
                : "configPage.deviceSettings.introIos",
            )}{" "}
            <LearnMoreLink
              url={`https://docs.openclaw.ai/platforms/${snapshot()?.device.platform ?? "macos"}`}
            />
          </>
        }
      />
      <SettingsWorkspace>
        <SettingsPage>
          <Show
            when={capability}
            fallback={<SettingsEmpty message={t("configPage.deviceSettings.appOnly")} />}
          >
            <Show
              when={Boolean(snapshot())}
              fallback={<SettingsEmpty message={t("configPage.deviceSettings.loading")} />}
            >
              <Settings snapshot={snapshot()!} />
            </Show>
          </Show>
        </SettingsPage>
      </SettingsWorkspace>
    </>
  );
}

export const DevicePage = defineSolidBridge("openclaw-device-page", DevicePageContent, {
  properties: {},
});
