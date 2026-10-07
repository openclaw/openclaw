import { property } from "lit/decorators.js";
import type { AgentIdentityResult } from "../api/types.ts";
import { resolveAgentAvatarUrl } from "../lib/avatar.ts";
import { IdentityAvatarController } from "../lib/identity-avatar-loader.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { renderAgentSelectAvatar, type AgentSelectOption } from "./agent-select.ts";

export class AgentAvatar extends OpenClawLightDomElement {
  @property({ attribute: false }) option: AgentSelectOption = { value: "", label: "" };

  @property({ attribute: false }) identity: AgentIdentityResult | null = null;

  private readonly avatarLoader = new IdentityAvatarController(this);

  protected override render() {
    return this.avatarLoader.withActiveRoutes(() => {
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
