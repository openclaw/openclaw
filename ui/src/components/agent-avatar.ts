import { property } from "lit/decorators.js";
import type { AgentIdentityResult } from "../api/types.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { IdentityAvatarController } from "../lib/identity-avatar-loader.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { renderAgentSelectAvatar, type AgentSelectOption } from "./agent-select.ts";
import { renderAgentIdentityAvatar } from "./identity-avatar-view.ts";

export type AgentAvatarPresentation = {
  agent: Parameters<typeof renderAgentIdentityAvatar>[0];
  className?: string;
  onImageError?: () => void;
};

export class AgentAvatar extends OpenClawLightDomElement {
  @property({ attribute: false }) option: AgentSelectOption = { value: "", label: "" };

  @property({ attribute: false }) identity: AgentIdentityResult | null = null;

  /** Renderer-neutral input for surfaces that already resolved their agent identity. */
  @property({ attribute: false }) presentation?: AgentAvatarPresentation;

  private readonly avatarLoader = new IdentityAvatarController(this);

  protected override render() {
    return this.avatarLoader.withActiveRoutes(() => {
      if (this.presentation) {
        return renderAgentIdentityAvatar(
          this.presentation.agent,
          this.presentation.className,
          this.presentation.onImageError,
        );
      }
      const url = this.option.agent
        ? resolveAgentAvatarUrl(this.option.agent, this.identity)
        : null;
      return renderAgentSelectAvatar(
        this.option,
        this.identity,
        url ? this.avatarLoader.resolve(url) : null,
        url ? this.avatarLoader.imageErrorHandler(url) : undefined,
      );
    });
  }
}

if (!customElements.get("openclaw-agent-avatar")) {
  customElements.define("openclaw-agent-avatar", AgentAvatar);
}
