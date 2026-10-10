import { property } from "lit/decorators.js";
import type { ControlUiSessionPullRequest } from "../../../../../src/gateway/control-ui-contract.js";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";

export abstract class ChatCiDisclosure extends OpenClawLightDomElement {
  @property({ attribute: false }) gateway?: ApplicationGateway;
  @property({ attribute: false }) pullRequest?: ControlUiSessionPullRequest;
  @property({ attribute: false }) sessionKey = "";
  @property({ type: Boolean }) presented = true;
  protected disclosure: HTMLDetailsElement | null = null;
  protected abstract readonly handleVisibility: () => void;
  protected abstract disconnect(): void;

  override connectedCallback(): void {
    super.connectedCallback();
    this.disclosure = this.closest<HTMLDetailsElement>(".chat-pr__checks");
    this.disclosure?.addEventListener("toggle", this.handleToggle);
    this.ownerDocument.addEventListener("visibilitychange", this.handleVisibility);
    this.requestUpdate();
  }

  override disconnectedCallback(): void {
    this.disclosure?.removeEventListener("toggle", this.handleToggle);
    this.ownerDocument.removeEventListener("visibilitychange", this.handleVisibility);
    this.disconnect();
    super.disconnectedCallback();
  }

  protected get visible(): boolean {
    return (
      this.isConnected &&
      this.presented &&
      this.disclosure?.open === true &&
      this.ownerDocument.visibilityState !== "hidden"
    );
  }

  private readonly handleToggle = (event: Event): void => {
    if (event.target === this.disclosure) {
      this.handleVisibility();
    }
  };
}
