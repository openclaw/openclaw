import type { AgentIdentityResult, AgentsListResult } from "../../api/types.ts";
import { AgentIdentityAvatar } from "../../components/solid/identity-avatar.tsx";
import { SettingsGroup } from "../../components/solid/settings-ui.tsx";
import { resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { themeBrandingProjection } from "../../lib/reactive/theme-branding.ts";

export function ProfileHero(props: {
  row: AgentsListResult["agents"][number];
  identity: AgentIdentityResult | null | undefined;
}) {
  const branding = themeBrandingProjection;
  const agentAvatar = () => ({
    id: props.row.id,
    name: name(),
    avatar: resolveAgentAvatarUrl(props.row, props.identity),
    textAvatar: resolveAgentTextAvatar(props.row, props.identity),
  });
  const name = () =>
    props.identity?.name?.trim() ||
    props.row.identity?.name?.trim() ||
    props.row.name?.trim() ||
    props.row.id;
  return (
    <SettingsGroup>
      <section class="profile-hero">
        <div class="profile-hero__avatar">
          <AgentIdentityAvatar agent={agentAvatar()} />
        </div>
        <div class="profile-hero__name">{name()}</div>
        <div class="profile-hero__handle">
          <span class="profile-hero__email">@{props.row.id}</span>
          <span class="profile-hero__badge">{branding.read().brandName}</span>
        </div>
      </section>
    </SettingsGroup>
  );
}
