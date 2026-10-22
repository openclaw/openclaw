import { createMemo, onSettled } from "solid-js";
import type { AgentIdentityResult } from "../../api/types.ts";
import { resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { createIdentityAvatars } from "../../lib/identity-avatar-loader.ts";
import { projectOwner } from "../../lib/reactive/projection.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import type { AgentSelectOption } from "../agent-select.ts";
import { AgentOptionAvatar } from "./identity-avatar.tsx";

export type AgentAvatarProps = {
  option: AgentSelectOption;
  identity: AgentIdentityResult | null;
};

export const AgentAvatar = defineSolidBridge<AgentAvatarProps>(
  "openclaw-agent-avatar",
  (props) => {
    const loader = createIdentityAvatars();
    onSettled(() => loader.connect());
    const avatarSource = projectOwner(loader, (owner) => owner);
    const avatar = createMemo(() => {
      const option = props.option;
      const identity = props.identity;
      const url = option.agent ? resolveAgentAvatarUrl(option.agent, identity) : null;
      return avatarSource.read().withActiveRoutes(() => ({
        image: url ? loader.resolve(url) : null,
        textAvatar: option.agent ? resolveAgentTextAvatar(option.agent, identity) : null,
        onError: url ? loader.imageErrorHandler(url) : undefined,
      }));
    });

    return <AgentOptionAvatar option={props.option} avatar={avatar()} />;
  },
  {
    properties: {
      option: { default: { value: "", label: "" }, attribute: false },
      identity: { default: null, attribute: false },
    },
  },
);

export type AgentAvatarElement = SolidBridgeElement<AgentAvatarProps>;

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-agent-avatar": AgentAvatarElement;
  }
}
