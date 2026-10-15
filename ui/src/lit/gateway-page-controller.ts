import { GatewayPageBinding, type GatewayPageBindingOptions } from "../lib/gateway-page-binding.ts";
import type { SolidController, SolidControllerHost } from "./solid-controller-host.ts";

/** Host lifecycle adapter; the binding owns connection and request identity. */
export class GatewayPageController extends GatewayPageBinding implements SolidController {
  private hostAttached = false;

  constructor(host: SolidControllerHost, options: GatewayPageBindingOptions) {
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
