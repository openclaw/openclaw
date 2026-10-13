import { Show } from "solid-js";
import type { AgentIdentityResult, AgentsListResult } from "../../api/types.ts";
import { currentThemeBranding, subscribeThemeBranding } from "../../app/theme-branding.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { renderAgentIdentityAvatar } from "../../components/identity-avatar-view.ts";
import { SettingsGroup } from "../../components/solid/settings-ui.tsx";
import { resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import "../../components/viewer-facepile.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { LitContent } from "../../lit/solid-bridge.ts";

export type ProfileHeroProps = {
  user?: AuthenticatedUser | null;
  row: AgentsListResult["agents"][number];
  identity: AgentIdentityResult | null | undefined;
};

export function ProfileHero(props: ProfileHeroProps) {
  const branding = projectSource(currentThemeBranding, {
    read: (read) => read(),
    subscribe: (_read, notify) => subscribeThemeBranding(notify),
    equality: Object.is,
  });
  const agentAvatar = () => {
    branding.read();
    return renderAgentIdentityAvatar({
      id: props.row.id,
      name: name(),
      avatar: resolveAgentAvatarUrl(props.row, props.identity),
      textAvatar: resolveAgentTextAvatar(props.row, props.identity),
    });
  };
  // An absent live name is authoritative; the editor's fetched profile may be stale.
  const name = () =>
    props.user
      ? props.user.name?.trim() || props.user.email || t("nav.owner")
      : props.identity?.name?.trim() ||
        props.row.identity?.name?.trim() ||
        props.row.name?.trim() ||
        props.row.id;
  const handle = () => (props.user ? props.user.email : `@${props.row.id}`);
  return (
    <SettingsGroup>
      <section class="profile-hero">
        <div class="profile-hero__avatar">
          <Show when={props.user} fallback={<LitContent render={agentAvatar} />}>
            {(user) => (
              <openclaw-viewer-avatar
                prop:user={{ ...user(), name: name(), watchedSessions: [] }}
                variant="profile"
              />
            )}
          </Show>
        </div>
        <div class="profile-hero__name">{name()}</div>
        <div class="profile-hero__handle">
          <Show when={handle()}>
            <span class="profile-hero__email">{handle()}</span>
          </Show>
          <span class="profile-hero__badge">{branding.read().brandName}</span>
        </div>
      </section>
    </SettingsGroup>
  );
}
