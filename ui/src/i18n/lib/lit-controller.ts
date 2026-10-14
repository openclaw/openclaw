import type { SolidController, SolidControllerHost } from "../../lit/solid-controller-host.ts";
import { i18n } from "./translate.ts";

export class I18nController implements SolidController {
  private unsubscribe?: () => void;

  constructor(private readonly host: SolidControllerHost) {
    host.addController(this);
  }

  hostConnected() {
    this.unsubscribe?.();
    this.unsubscribe = i18n.subscribe(() => this.host.requestUpdate());
    // The locale may have changed while the host was disconnected.
    this.host.requestUpdate();
  }

  hostDisconnected() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }
}
