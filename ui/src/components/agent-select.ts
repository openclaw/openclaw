import { html, nothing } from "lit";
import type { AgentIdentityResult } from "../api/types.ts";
import { resolveAgentTextAvatar } from "../lib/agents/display.ts";
import type { AgentSelectOption } from "./agent-select-types.ts";
import { renderAgentIdentityAvatar } from "./identity-avatar-view.ts";

export type { AgentSelectOption } from "./agent-select-types.ts";

export function renderAgentSelectAvatar(
  option: AgentSelectOption,
  identity: AgentIdentityResult | null,
  imageUrl: string | null,
  onImageError?: () => void,
) {
  if (option.icon && !imageUrl) {
    return html`<span class="agent-select__avatar agent-select__avatar--icon" aria-hidden="true"
      >${option.icon}</span
    >`;
  }
  return renderAgentIdentityAvatar(
    {
      id: option.agent?.id ?? option.value,
      avatar: imageUrl,
      textAvatar: option.agent ? resolveAgentTextAvatar(option.agent, identity) : null,
    },
    "agent-select__avatar",
    onImageError,
  );
}

export function renderAgentSelectCopy(option: AgentSelectOption) {
  return html`
    <span class="agent-select__option-copy">
      <span class="agent-select__option-heading">
        <span class="agent-select__option-label">${option.label}</span>
        ${option.badge ? html`<span class="agent-select__badge">${option.badge}</span>` : nothing}
      </span>
      ${
        option.description
          ? html`<span class="agent-select__option-description">${option.description}</span>`
          : nothing
      }
    </span>
  `;
}

export type { AgentSelect, AgentSelectElement } from "./agent-select.tsx";
