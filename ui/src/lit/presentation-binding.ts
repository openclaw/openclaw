import { nothing } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";
import type { Part } from "lit/directive.js";
import { live } from "lit/directives/live.js";

export const PRESENTATION_CHANGED_EVENT = "openclaw:presentation-changed";

export type PresentationBinding = {
  owner: EventTarget;
  isPresented: () => boolean;
  /** Visual navigation previews can activate warmed content before the parent commits. */
  preview?: () => boolean;
};

export type PresentationValue = boolean | PresentationBinding;

/** Child lifecycles follow presentation even when their retained parent parks renders. */
class PresentationDirective extends AsyncDirective {
  private value: PresentationValue = false;
  private project: (presented: boolean) => unknown = () => nothing;
  private owner?: EventTarget;
  private readonly refresh = () => {
    // Restore with the parent's next commit so connection and layout props arrive together.
    // Only explicit navigation previews may reuse the warmed child's previous props.
    if (typeof this.value !== "boolean" && (!this.value.isPresented() || this.value.preview?.())) {
      this.setValue(this.render(this.value, this.project));
    }
  };

  override update(
    _part: Part,
    [value, project]: [PresentationValue, (presented: boolean) => unknown],
  ) {
    this.value = value;
    this.project = project;
    const owner = typeof value === "boolean" ? undefined : value.owner;
    if (this.owner !== owner) {
      this.unsubscribe();
      this.owner = owner;
      if (this.isConnected) {
        this.owner?.addEventListener(PRESENTATION_CHANGED_EVENT, this.refresh);
      }
    }
    return this.render(value, project);
  }

  override render(value: PresentationValue, project: (presented: boolean) => unknown) {
    const presented = typeof value === "boolean" ? value : value.isPresented();
    return project(presented);
  }

  private unsubscribe(): void {
    this.owner?.removeEventListener(PRESENTATION_CHANGED_EVENT, this.refresh);
  }

  override disconnected(): void {
    this.unsubscribe();
  }

  override reconnected(): void {
    this.owner?.addEventListener(PRESENTATION_CHANGED_EVENT, this.refresh);
    this.refresh();
  }
}

const presentation = directive(PresentationDirective);

export function livePresentation(value: PresentationValue, inverted = false) {
  return presentation(value, (presented) => live(inverted ? !presented : presented));
}

export function presentedContent(value: PresentationValue, content: unknown) {
  return presentation(value, (presented) => (presented ? content : nothing));
}

export function presentedProperty<T>(value: PresentationValue, shown: T, hidden: T) {
  return presentation(value, (presented) => live(presented ? shown : hidden));
}
