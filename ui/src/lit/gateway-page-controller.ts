import type { ReactiveController, ReactiveControllerHost } from "lit";
import { GatewayPageBinding, type GatewayPageBindingOptions } from "../lib/gateway-page-binding.ts";

export type { GatewayPageChange } from "../lib/gateway-page-binding.ts";

/** Lit lifecycle adapter; the binding owns connection and request identity. */
export class GatewayPageController extends GatewayPageBinding implements ReactiveController {
  private hostAttached = false;

  constructor(host: ReactiveControllerHost, options: GatewayPageBindingOptions) {
    super(() => host.requestUpdate(), options);
    host.addController(this);
  }

  hostConnected(): void {
    this.hostAttached = true;
    this.connect();
  }

  hostUpdate(): void {
    if (this.hostAttached) {
      this.refresh();
    }
  }

  hostDisconnected(): void {
    this.hostAttached = false;
    this.dispose();
  }
}
