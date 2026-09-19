import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import {
  createNativeChromeSetupCapability,
  type NativeChromeSetupCapability,
  type NativeChromeExtensionSetupAction,
  type NativeChromeExtensionSetupResult,
} from "../app/native-chrome-setup.ts";
import type { LegacyChromeInstallResult } from "../app/native-device-settings.ts";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { renderChromeSetupStatus } from "./chrome-setup-status.ts";
import "./native-chrome-setup.css";

class NativeChromeSetup extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;
  @state() private running = false;
  @state() private failed = false;
  @state() private result: NativeChromeExtensionSetupResult | null = null;
  @state() private legacyResult: LegacyChromeInstallResult | null = null;
  private desktopCapability: NativeChromeSetupCapability | null = null;
  private generation = 0;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.nativeDeviceSettings,
      (capability, notify) => capability.subscribe(notify),
    )
    .effect(
      () => this.context?.nativeDeviceSettings,
      () => () => this.reset(),
    );

  override connectedCallback() {
    this.desktopCapability = createNativeChromeSetupCapability();
    super.connectedCallback();
  }
  override disconnectedCallback() {
    this.reset();
    this.desktopCapability?.dispose();
    this.desktopCapability = null;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }
  private get macCapability() {
    const mac = this.context?.nativeDeviceSettings;
    return mac?.snapshot?.device.platform === "macos" ? mac : null;
  }
  private get capability() {
    // The Mac app's existing context owns its device-settings transport.
    return this.macCapability ?? this.desktopCapability;
  }
  private get actions(): readonly NativeChromeExtensionSetupAction[] {
    const mac = this.macCapability;
    if (!mac) {
      return this.desktopCapability ? ["install", "inspect", "verify"] : [];
    }
    const browser = mac.snapshot?.browser;
    if (!browser) {
      return [];
    }
    return browser.chromeSetupActions ?? (mac.installChromeExtension ? ["install"] : []);
  }
  private reset() {
    this.generation += 1;
    this.running = false;
    this.failed = false;
    this.result = null;
    this.legacyResult = null;
  }
  private async setup(action: NativeChromeExtensionSetupAction) {
    const capability = this.capability;
    if (!this.isConnected || !capability || this.running || !this.actions.includes(action)) {
      return;
    }
    const generation = ++this.generation;
    const isCurrent = () =>
      this.isConnected && this.capability === capability && this.generation === generation;
    this.running = true;
    this.failed = false;
    this.result = null;
    this.legacyResult = null;
    try {
      const mac = this.macCapability;
      if (mac && mac.snapshot?.browser?.chromeSetupActions === undefined) {
        if (action !== "install" || !mac.installChromeExtension) {
          return;
        }
        const result = await mac.installChromeExtension();
        if (isCurrent() && this.actions.includes(action)) {
          this.legacyResult = result;
        }
      } else {
        const result = await capability.setupChromeExtension(action);
        if (isCurrent() && this.actions.includes(action)) {
          this.result = result;
        }
      }
    } catch {
      if (isCurrent()) {
        this.failed = true;
      }
    } finally {
      if (isCurrent()) {
        this.running = false;
      }
    }
  }
  override render() {
    if (!this.capability) {
      return nothing;
    }
    return html`
      <div class="native-chrome-setup">
        <p>${t("configPage.deviceSettings.chromeExtensionHint")}</p>
        <div class="native-chrome-setup__actions">
          ${(
            [
              ["install", "chromeExtensionSetup"],
              ["inspect", "chromeExtensionRefresh"],
              ["verify", "chromeExtensionVerify"],
            ] as const
          )
            .filter(([action]) => this.actions.includes(action))
            .map(
              ([action, label]) => html`
                <button
                  type="button"
                  class="btn"
                  ?disabled=${this.running}
                  @click=${() => this.setup(action)}
                >
                  ${t(`configPage.deviceSettings.${label}`)}
                </button>
              `,
            )}
        </div>
        ${renderChromeSetupStatus({ result: this.result, legacyResult: this.legacyResult, running: this.running, failed: this.failed })}
      </div>
    `;
  }
}
if (!customElements.get("openclaw-native-chrome-setup")) {
  customElements.define("openclaw-native-chrome-setup", NativeChromeSetup);
}
