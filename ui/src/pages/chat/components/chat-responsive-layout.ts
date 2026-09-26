import { nothing } from "lit";
import { AsyncDirective, directive } from "lit/async-directive.js";

class ChatResponsiveLayoutDirective extends AsyncDirective {
  private readonly media = globalThis.matchMedia?.(
    "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
  );
  private content: (mobile: boolean) => unknown = () => nothing;
  private readonly updateLayout = () => {
    this.setValue(this.content(this.media?.matches ?? false));
  };

  render(content: (mobile: boolean) => unknown) {
    this.content = content;
    if (this.isConnected) {
      this.media?.addEventListener("change", this.updateLayout);
    }
    return content(this.media?.matches ?? false);
  }

  protected override disconnected() {
    this.media?.removeEventListener("change", this.updateLayout);
  }

  protected override reconnected() {
    this.media?.addEventListener("change", this.updateLayout);
    this.updateLayout();
  }
}

export const chatResponsiveLayout = directive(ChatResponsiveLayoutDirective);
