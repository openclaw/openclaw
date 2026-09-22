import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import type {
  NativeChromeExtensionSetupAction,
  NativeChromeExtensionSetupResult,
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
  @property({ type: Boolean, attribute: "auto-inspect" }) autoInspect = false;
  @state() private running = false;
  @state() private failed: "inspection" | "setup" | null = null;
  @state() private result: NativeChromeExtensionSetupResult | null = null;
  @state() private legacyResult: LegacyChromeInstallResult | null = null;
  private generation = 0;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.nativeDeviceSettings,
      (capability, notify) => capability.subscribe(notify),
    )
    .effect(
      () => this.context?.nativeDeviceSettings,
      () => () => this.reset(),
    )
    .effect(
      () => (this.autoInspect && this.capability?.snapshot?.browser ? this.capability : undefined),
      () => {
        const inspect = () => void this.setup("inspect");
        window.addEventListener("focus", inspect);
        inspect();
        return () => {
          window.removeEventListener("focus", inspect);
          this.reset();
        };
      },
    );

  override disconnectedCallback() {
    this.reset();
    this.subscriptions.clear();
    super.disconnectedCallback();
  }
  private get capability() {
    return this.context?.nativeDeviceSettings;
  }
  private get actions(): readonly NativeChromeExtensionSetupAction[] {
    const capability = this.capability;
    const browser = capability?.snapshot?.browser;
    if (!capability || !browser) {
      return [];
    }
    if (browser.chromeSetupActions) {
      return browser.chromeSetupActions;
    }
    if (capability.snapshot?.device.platform !== "macos") {
      return [];
    }
    return [
      ...(capability.installChromeExtension ? ["install" as const] : []),
      ...(this.autoInspect && capability.chromeExtensionStatus ? ["inspect" as const] : []),
    ];
  }
  private get needsInstall() {
    const installation = this.result?.installation ?? this.legacyResult;
    return (
      !installation ||
      !installation.nativeHostRegistered ||
      (installation.installedProfiles ?? installation.discoveredProfiles) === 0
    );
  }
  private reset() {
    this.generation += 1;
    this.running = false;
    this.failed = null;
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
    this.failed = null;
    this.result = null;
    this.legacyResult = null;
    try {
      if (capability.snapshot?.browser?.chromeSetupActions === undefined) {
        let result: LegacyChromeInstallResult;
        if (action === "inspect" && capability.chromeExtensionStatus) {
          result = await capability.chromeExtensionStatus();
        } else if (action === "install" && capability.installChromeExtension) {
          result = await capability.installChromeExtension();
        } else {
          return;
        }
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
        this.failed = this.autoInspect && action === "inspect" ? "inspection" : "setup";
      }
    } finally {
      if (isCurrent()) {
        this.running = false;
      }
    }
  }
  override render() {
    if (!this.capability?.snapshot?.browser) {
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
            .filter(
              ([action]) =>
                this.actions.includes(action) &&
                (action !== "install" || !this.autoInspect || this.needsInstall),
            )
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
