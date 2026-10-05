import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { TabIconPreference } from "../../../../packages/gateway-protocol/src/schema/tab-icon.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadSettings, type UiSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { assertUploadsEnabled, uploadsEnabled } from "../../lib/uploads.ts";
import type { ConfigPageId } from "./config-sections.ts";
import { fileToTabIconImage } from "./tab-icon-image.ts";
import type { TabIconViewProps } from "./view-tab-icon.ts";

type TabIconSettingsHost = ReactiveControllerHost & {
  readonly isConnected: boolean;
  readonly pageId: ConfigPageId;
};

type TabIconSettingsOptions = {
  getContext: () => ApplicationContext;
  getPreference: () => UiSettings["tabIcon"];
  applySettings: (patch: Pick<UiSettings, "tabIcon">) => void;
};

/** Owns only the page's upload intent; ConfigPage retains settings application. */
export class TabIconSettingsController implements ReactiveController {
  private busy = false;
  private error: string | null = null;
  private pendingUpload: { controller: AbortController; isCurrent: () => boolean } | null = null;

  constructor(
    private readonly host: TabIconSettingsHost,
    private readonly options: TabIconSettingsOptions,
  ) {
    host.addController(this);
  }

  get props(): TabIconViewProps {
    return {
      tabIcon: this.options.getPreference(),
      tabIconBusy: this.busy,
      tabIconError: this.error,
      tabIconUploadsEnabled: uploadsEnabled(this.options.getContext().config),
      setTabIconMode: (mode) => this.setMode(mode),
      onTabIconFileChange: (file) => void this.upload(file),
      onRemoveTabIconImage: () => this.removeImage(),
    };
  }

  hostUpdate() {
    this.synchronize();
  }

  hostDisconnected() {
    this.cancelUpload();
  }

  cancelUpload() {
    this.pendingUpload?.controller.abort();
    this.pendingUpload = null;
    if (this.busy || this.error !== null) {
      this.busy = false;
      this.error = null;
      this.host.requestUpdate();
    }
  }

  synchronize() {
    if (this.pendingUpload && !this.pendingUpload.isCurrent()) {
      this.cancelUpload();
    }
  }

  private setMode(mode: TabIconPreference["mode"]) {
    this.cancelUpload();
    this.options.applySettings({ tabIcon: { ...this.options.getPreference(), mode } });
  }

  private removeImage() {
    this.cancelUpload();
    this.options.applySettings({ tabIcon: { mode: "custom" } });
  }

  async upload(file: File) {
    this.cancelUpload();
    if (!uploadsEnabled(this.options.getContext().config)) {
      this.error = t("common.uploadsDisabled");
      this.host.requestUpdate();
      return;
    }
    if (
      !this.host.isConnected ||
      this.host.pageId !== "appearance" ||
      this.options.getPreference()?.mode !== "custom"
    ) {
      return;
    }
    const context = this.options.getContext();
    const gateway = context.gateway;
    const config = context.config;
    const phase = gateway.snapshot.phase;
    const client = gateway.snapshot.client;
    const gatewayUrl = gateway.connection.gatewayUrl;
    const profileId = gateway.snapshot.selfUser?.id;
    const selection = context.settingsAgentSelection;
    const selectionRevision = selection.intentRevision;
    const preference = JSON.stringify(this.options.getPreference());
    const controller = new AbortController();
    // The live owners, not the render closure, decide whether this result may apply.
    const isCurrent = () =>
      !controller.signal.aborted &&
      this.host.isConnected &&
      this.host.pageId === "appearance" &&
      this.options.getContext() === context &&
      this.options.getContext().gateway === gateway &&
      this.options.getContext().config === config &&
      gateway.snapshot.phase === phase &&
      gateway.snapshot.client === client &&
      gateway.connection.gatewayUrl === gatewayUrl &&
      gateway.snapshot.selfUser?.id === profileId &&
      this.options.getContext().settingsAgentSelection === selection &&
      selection.intentRevision === selectionRevision &&
      JSON.stringify(this.options.getPreference()) === preference &&
      uploadsEnabled(this.options.getContext().config);
    this.pendingUpload = { controller, isCurrent };
    this.busy = true;
    this.host.requestUpdate();
    try {
      assertUploadsEnabled(config);
      const result = await fileToTabIconImage(file, config, controller.signal);
      if (!isCurrent() || JSON.stringify(loadSettings().tabIcon) !== preference) {
        return;
      }
      assertUploadsEnabled(this.options.getContext().config);
      if (result.ok) {
        this.options.applySettings({ tabIcon: { mode: "custom", image: result.image } });
      } else if (result.reason !== "cancelled") {
        this.error = t(
          result.reason === "too-large"
            ? "configView.appearance.tabIcon.tooLarge"
            : result.reason === "too-detailed"
              ? "configView.appearance.tabIcon.tooDetailed"
              : "configView.appearance.tabIcon.unusable",
        );
      }
    } catch (error) {
      if (isCurrent()) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.pendingUpload?.controller === controller) {
        this.pendingUpload = null;
        this.busy = false;
        this.host.requestUpdate();
      }
    }
  }
}
