import { createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { COMMUNITY_DISCORD_URL } from "../../lib/product-links.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { showToast } from "../../lib/toast.ts";
import {
  COMMUNITY_INVITE_KEY,
  dismissCommunityInvite,
  isCommunityInviteEligible,
} from "../community-invite-state.ts";
import { BrandIcon, Icon } from "./icon.tsx";
import "../../styles/community-invite-card.css";

const communityLinks = [
  { platform: "Discord", label: "join", href: COMMUNITY_DISCORD_URL, icon: "discord" },
  { platform: "Reddit", label: "join", href: "https://www.reddit.com/r/openclaw/", icon: "reddit" },
  { platform: "X", label: "follow", href: "https://x.com/openclaw", icon: "x" },
] as const;

export function SidebarCommunityInvite(props: { onDismiss: () => void }) {
  const [eligible, setEligible] = createSignal(isCommunityInviteEligible());
  const titleId = createUniqueId();
  onSettled(() =>
    listen(window, "storage", (event) => {
      if (event.key === COMMUNITY_INVITE_KEY || event.key === null) {
        setEligible(isCommunityInviteEligible());
      }
    }),
  );
  const dismiss = () => {
    const result = dismissCommunityInvite();
    setEligible(false);
    props.onDismiss();
    if (!result.ok) {
      showToast({ message: t("communityInvite.dismissFailed") });
    }
  };
  return (
    <Show when={eligible()}>
      <section class="community-invite-card" aria-labelledby={titleId}>
        <div class="sidebar-community__header">
          <h2 id={titleId}>{t("communityInvite.title")}</h2>
          <button
            type="button"
            class="sidebar-community__close"
            aria-label={t("communityInvite.dismissForever")}
            onClick={dismiss}
          >
            <Icon name="x" />
          </button>
        </div>
        <p class="sidebar-community__description">{t("communityInvite.body")}</p>
        <div class="sidebar-community__links">
          <For each={communityLinks}>
            {(link) => (
              <a
                class="sidebar-community__link"
                href={link.href}
                target={EXTERNAL_LINK_TARGET}
                rel={buildExternalLinkRel()}
                aria-label={t(`communityInvite.${link.label}Platform`, { platform: link.platform })}
              >
                <BrandIcon name={link.icon} />
                <span translate="no">{link.platform}</span>
              </a>
            )}
          </For>
        </div>
      </section>
    </Show>
  );
}
