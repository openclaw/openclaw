import { nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import {
  ShellLayoutOwner,
  shellLayoutOwnerForHost,
  type ShellLayoutTraits,
} from "./shell-layout-owner.ts";

export type { ShellLayoutTraits } from "./shell-layout-owner.ts";

/** Render owners publish layout facts before their descendants can measure layout. */
class ShellLayoutTraitsDirective extends AsyncDirective {
  private host?: Element;
  private traits: ShellLayoutTraits = {};
  private controller?: ShellLayoutOwner;

  render(_traits: ShellLayoutTraits) {
    return nothing;
  }

  override update(part: ElementPart, [traits]: [ShellLayoutTraits]) {
    this.host = part.options?.host instanceof Element ? part.options.host : undefined;
    this.traits = traits;
    this.publish();
    return nothing;
  }

  private publish() {
    // The new element is still detached. Its connected rendering host already
    // identifies the content scope, including templates rendered by the outlet.
    const controller =
      this.isConnected && this.host ? shellLayoutOwnerForHost(this.host) : undefined;
    if (controller !== this.controller) {
      this.controller?.clear(this);
      this.controller = controller;
    }
    if (this.host) {
      this.controller?.record(this, this.host, this.traits);
    }
  }

  protected override disconnected() {
    this.controller?.clear(this);
    this.controller = undefined;
  }

  protected override reconnected() {
    this.publish();
  }
}

export const shellLayoutTraits = directive(ShellLayoutTraitsDirective);

export class ShellLayoutController extends ShellLayoutOwner implements ReactiveController {
  constructor(host: ReactiveControllerHost) {
    super(() => host.requestUpdate());
    host.addController(this);
  }
}
