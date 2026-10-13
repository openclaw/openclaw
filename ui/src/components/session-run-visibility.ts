import { nothing } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ElementPart } from "lit/directive.js";
import { SessionRunVisibilityController } from "./session-run-visibility-controller.ts";

class SessionRunVisibility extends AsyncDirective {
  private readonly controller = new SessionRunVisibilityController();
  private element?: Element;

  render() {
    return nothing;
  }

  override update(part: ElementPart) {
    this.element = part.element;
    this.controller.connect(part.element);
    return nothing;
  }

  protected override disconnected() {
    this.controller.disconnect();
  }
  protected override reconnected() {
    if (this.element) {
      this.controller.connect(this.element);
    }
  }
}

export const sessionRunVisibility = directive(SessionRunVisibility);
