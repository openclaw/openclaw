import { noChange, type TemplateResult } from "lit";
import { AsyncDirective } from "lit/async-directive.js";
import { directive, type ChildPart } from "lit/directive.js";
import { OpenClawModalDialog } from "../../components/modal-dialog.ts";

type PreviewScope = readonly [agentId: string, fileName: string, loaded: boolean];

// Preserve the initial file preparation and mounted controls. Only repeated
// closed-preview updates are unnecessary; refresh before showModal takes focus.
class AgentFilePreviewDirective extends AsyncDirective {
  private modal?: OpenClawModalDialog;
  private content?: () => TemplateResult;
  private scope?: PreviewScope;

  override render(_scope: PreviewScope, _content: () => TemplateResult) {
    return noChange;
  }

  override update(part: ChildPart, [scope, content]: [PreviewScope, () => TemplateResult]) {
    if (!this.modal) {
      const modal = part.parentNode;
      if (!(modal instanceof OpenClawModalDialog)) {
        throw new Error("Agent file preview must be a modal child");
      }
      this.modal = modal;
      modal.addEventListener("wa-show", this.show);
    }
    const newFile = !this.scope || scope.some((value, index) => value !== this.scope?.[index]);
    this.scope = scope;
    this.content = content;
    return newFile || (this.modal.isConnected && this.modal.open) ? content() : noChange;
  }

  private show = (event: Event) => {
    // A nested overlay must not replace the document or disturb its selection.
    if (event.target === this.modal && this.isConnected && this.content) {
      this.setValue(this.content());
    }
  };

  protected override disconnected() {
    this.modal?.removeEventListener("wa-show", this.show);
  }

  protected override reconnected() {
    this.modal?.addEventListener("wa-show", this.show);
  }
}

export const agentFilePreview = directive(AgentFilePreviewDirective);
