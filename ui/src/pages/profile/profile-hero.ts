import { html, nothing } from "lit";
import type { AgentIdentityResult, AgentsListResult } from "../../api/types.ts";
import type { AuthenticatedUser } from "../../app/user-profile.ts";
import { renderAgentIdentityAvatar } from "../../components/identity-avatar-view.ts";
import { renderSettingsGroup } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { resolveAgentTextAvatar } from "../../lib/agents/display.ts";
import { resolveAgentAvatarUrl } from "../../lib/avatar.ts";
import type { IdentityAvatarController } from "../../lib/identity-avatar-loader.ts";
import "../../components/viewer-facepile.ts";

export type ProfileHeroProps = {
  user?: AuthenticatedUser | null;
  row: AgentsListResult["agents"][number];
  identity: AgentIdentityResult | null | undefined;
  avatarLoader: Pick<IdentityAvatarController, "resolve" | "imageErrorHandler">;
};

function renderHeroAvatar(props: ProfileHeroProps, name: string) {
  if (props.user) {
    return html`<openclaw-viewer-avatar
      .user=${{ ...props.user, name, watchedSessions: [] }}
      variant="profile"
    ></openclaw-viewer-avatar>`;
  }
  const avatarUrl = resolveAgentAvatarUrl(props.row, props.identity);
  return renderAgentIdentityAvatar(
    {
      id: props.row.id,
      name,
      avatar: avatarUrl ? props.avatarLoader.resolve(avatarUrl) : null,
      textAvatar: resolveAgentTextAvatar(props.row, props.identity),
    },
    "",
    avatarUrl ? props.avatarLoader.imageErrorHandler(avatarUrl) : undefined,
  );
}

export function renderProfileHero(props: ProfileHeroProps) {
  // An absent live name is authoritative; the editor's fetched profile may be stale.
  const name = props.user
    ? props.user.name?.trim() || props.user.email || t("nav.owner")
    : props.identity?.name?.trim() ||
      props.row.identity?.name?.trim() ||
      props.row.name?.trim() ||
      props.row.id;
  const handle = props.user ? props.user.email : `@${props.row.id}`;
  return renderSettingsGroup(html`
    <section class="profile-hero">
      <div class="profile-hero__avatar">${renderHeroAvatar(props, name)}</div>
      <div class="profile-hero__name">${name}</div>
      <div class="profile-hero__handle">
        ${handle ? html`<span class="profile-hero__email">${handle}</span>` : nothing}
        <span class="profile-hero__badge">OpenClaw</span>
      </div>
    </section>
  `);
}
