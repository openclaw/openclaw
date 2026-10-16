import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { PanelLifecycleController, SolidPanelController } from "./solid-panel-controller.ts";

export class DesktopFullscreenController implements PanelLifecycleController {
  active = false;
  errorText: string | null = null;

  private restoreFocus = false;

  constructor(
    private readonly host: Pick<
      SolidPanelController,
      "renderRoot" | "addController" | "requestUpdate" | "updateComplete"
    >,
    private readonly onChange: () => void,
  ) {
    host.addController(this);
  }

  hostConnected(): void {
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
  }

  hostDisconnected(): void {
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    this.restoreFocus = false;
    if (this.ownsFullscreen()) {
      void document.exitFullscreen().catch(() => {});
    }
  }

  private async exit(): Promise<void> {
    try {
      await document.exitFullscreen();
    } catch (error) {
      this.setError(t("desktop.errors.fullscreenFailed", { error: formatUiError(error) }));
    }
  }

  private ownsFullscreen(): boolean {
    const section = this.host.renderRoot.querySelector<HTMLElement>("section.bp");
    if (!section) {
      return false;
    }
    return document.fullscreenElement === section;
  }

  supported(): boolean {
    return document.fullscreenEnabled && typeof Element.prototype.requestFullscreen === "function";
  }

  private readonly onFullscreenChange = (): void => {
    const wasActive = this.active;
    this.active = this.ownsFullscreen();
    this.onChange();
    this.host.requestUpdate();
    if (wasActive && !this.active && this.restoreFocus) {
      // Escape and browser controls exit outside the component. Restore focus so
      // keyboard operators return to the control that changed the viewport.
      void this.host.updateComplete.then(() => {
        this.host.renderRoot
          .querySelector<HTMLButtonElement>(".desktop-fullscreen-button")
          ?.focus();
        this.restoreFocus = false;
      });
    }
  };

  async toggle(): Promise<void> {
    this.setError(null);
    if (this.active) {
      await this.exit();
      return;
    }
    const section = this.host.renderRoot.querySelector<HTMLElement>("section.bp");
    if (!section || !this.supported()) {
      this.setError(t("desktop.fullscreenUnavailable"));
      return;
    }
    this.restoreFocus = true;
    try {
      await section.requestFullscreen();
    } catch (error) {
      this.restoreFocus = false;
      this.setError(t("desktop.errors.fullscreenFailed", { error: formatUiError(error) }));
    }
  }

  private setError(errorText: string | null): void {
    this.errorText = errorText;
    this.host.requestUpdate();
  }
}
