import type { ReactiveController, ReactiveControllerHost } from "lit";
import { i18n } from "./translate.ts";

export class I18nController implements ReactiveController {
  private unsubscribe?: () => void;

  constructor(private readonly host: ReactiveControllerHost) {
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
