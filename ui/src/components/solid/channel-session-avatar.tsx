import { createMemo, Show } from "solid-js";
import { buildControlUiResourcePath } from "../../../../src/gateway/control-ui-resource-routes.js";
import { resolveControlUiAvatarAuth } from "../../app/control-ui-auth.ts";
import { resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { takeGraphemes } from "../../lib/graphemes.ts";
import { projectAgentRowContext } from "../../lib/reactive/agent-row-context.ts";
import { useOptionalApplication } from "../../lib/reactive/context.ts";
import { resolveUiDefaultAgentId } from "../../lib/sessions/session-key.ts";
import { pluginFallbackGradient } from "../../pages/plugins/presentation.tsx";
import { ChannelAvatar } from "./channel-avatar.tsx";
import { AgentIdentityAvatar } from "./identity-avatar.tsx";

type ChannelSessionAvatarProps = {
  agentId?: string;
  channel: string;
  channelLabel: string;
  /** The person or room's own photo, when the channel shares one. */
  contactAvatarUrl?: string;
  /** Rows pass their shared credentials; standalone faces read the application's. */
  avatarAuth?: { authTokens: readonly string[]; authReady: boolean };
};

/**
 * A channel conversation's face: the contact's photo when the channel shares one,
 * otherwise the agent who answers there, with the channel's plugin icon as a corner badge.
 */
export function ChannelSessionAvatar(props: ChannelSessionAvatarProps) {
  const application = useOptionalApplication();
  const context = projectAgentRowContext(application);
  const agent = createMemo(() => {
    const app = context.read();
    const agentsList = app?.agents.state.agentsList;
    const id =
      props.agentId?.trim() ||
      resolveUiDefaultAgentId({ agentsList, hello: app?.gateway.snapshot.hello });
    const entry = agentsList?.agents.find((candidate) => candidate.id === id) ?? { id };
    const identity = app?.agentIdentity.get(id);
    return {
      id,
      avatar: resolveAgentAvatarUrl(entry, identity),
      textAvatar: resolveAgentTextAvatar(entry, identity),
    };
  });
  const auth = createMemo(() => {
    if (props.avatarAuth) {
      return props.avatarAuth;
    }
    const gateway = context.read()?.gateway;
    return resolveControlUiAvatarAuth({
      hello: gateway?.snapshot.hello,
      settings: gateway?.connection,
      password: gateway?.connection.password,
    });
  });
  const iconRoute = createMemo(() =>
    buildControlUiResourcePath("pluginIcon", application?.resourceBasePath ?? "", props.channel),
  );
  const fallback = createMemo(() => {
    const [from, to] = pluginFallbackGradient(props.channel);
    return `--channels-art-a:${from};--channels-art-b:${to}`;
  });
  const AgentFace = () => (
    <AgentIdentityAvatar
      agent={{ id: agent().id, avatar: agent().avatar, textAvatar: agent().textAvatar }}
    />
  );
  return (
    <span class="channel-session-avatar" data-channel={props.channel}>
      <span class="channel-session-avatar__face">
        <Show when={props.contactAvatarUrl} fallback={<AgentFace />}>
          {(url) => (
            <ChannelAvatar
              routeUrl={url()}
              authTokens={auth().authTokens}
              authReady={auth().authReady}
            >
              <AgentFace />
            </ChannelAvatar>
          )}
        </Show>
      </span>
      <span class="channel-session-avatar__badge">
        <ChannelAvatar
          routeUrl={iconRoute()}
          authTokens={auth().authTokens}
          authReady={auth().authReady}
        >
          <span class="channel-session-avatar__monogram" style={fallback()}>
            {takeGraphemes(props.channelLabel, 1).toLocaleUpperCase()}
          </span>
        </ChannelAvatar>
      </span>
    </span>
  );
}
