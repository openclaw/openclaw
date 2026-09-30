import { createRef } from "lit/directives/ref.js";
import type { FloatingProgressDisclosure } from "../../components/session-progress-floating.ts";

type ProgressScope = {
  gateway: object;
  identity: string;
  sessionId: string | null | undefined;
  lifetime: object | undefined;
};

/** One retained pane owns its choice; revisions and responsive fallback do not reset it. */
export class ChatFloatingProgress {
  private scope: ProgressScope | undefined;
  private panelKey = "";
  private expanded = true;
  private readonly element = createRef<HTMLElement>();

  constructor(private readonly requestUpdate: () => void) {}

  sync(scope: ProgressScope | undefined, panelKey: string, collapseByDefault = false): void {
    const previous = this.scope;
    if (
      !previous ||
      !scope ||
      previous.gateway !== scope.gateway ||
      previous.identity !== scope.identity ||
      previous.sessionId !== scope.sessionId ||
      previous.lifetime !== scope.lifetime
    ) {
      this.expanded = !panelKey && !collapseByDefault;
    } else if (panelKey && panelKey !== this.panelKey) {
      this.collapse();
    }
    this.scope = scope;
    this.panelKey = panelKey;
  }

  private collapse(): void {
    const root = this.element.value;
    if (root?.querySelector(".session-progress-card__reveal")?.contains(document.activeElement)) {
      root
        .querySelector<HTMLButtonElement>(".session-progress-card__toggle")
        ?.focus({ preventScroll: true });
    }
    this.expanded = false;
  }

  disclosure(bodyId: string, onHide: () => void): FloatingProgressDisclosure {
    const owner = this.scope;
    return {
      expanded: this.expanded,
      bodyId,
      element: this.element,
      onHide: () => {
        if (this.scope === owner) {
          onHide();
        }
      },
      onToggle: () => {
        if (this.scope !== owner) {
          return;
        }
        if (this.expanded) {
          this.collapse();
        } else {
          this.expanded = true;
        }
        this.requestUpdate();
      },
      onKeydown: (event) => {
        if (
          this.scope !== owner ||
          event.key !== "Escape" ||
          event.isComposing ||
          event.defaultPrevented ||
          !this.expanded
        ) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.collapse();
        this.requestUpdate();
      },
    };
  }
}
