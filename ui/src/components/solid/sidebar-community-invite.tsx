import { For } from "solid-js";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { COMMUNITY_DISCORD_URL } from "../../lib/product-links.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { BrandIcon, Icon } from "./icon.tsx";
import "../../styles/community-invite-card.css";

const communityLinks = [
  {
    platform: "Reddit",
    label: "join",
    href: "https://www.reddit.com/r/openclaw/",
    icon: "reddit",
  },
  {
    platform: "Discord",
    label: "join",
    href: COMMUNITY_DISCORD_URL,
    icon: "discord",
  },
  {
    platform: "X",
    label: "follow",
    href: "https://x.com/openclaw",
    icon: "x",
  },
] as const;

export function SidebarCommunityInvite(props: { onDismiss: () => void; mode: "light" | "dark" }) {
  return (
    <div class="community-invite-card">
      <aside class="invite" role="complementary" aria-labelledby="community-invite-title">
        <div class="invite__header">
          <img
            class="invite__art"
            src={inferControlUiPublicAssetPath(`community-art/community-invite-${props.mode}.webp`)}
            alt=""
            width="1024"
            height="512"
            loading="lazy"
            decoding="async"
          />
          <div class="invite__marks" dir="ltr" aria-hidden="true">
            <For each={communityLinks}>{(link) => <BrandIcon name={link.icon} />}</For>
          </div>
          <button
            class="invite__close"
            type="button"
            aria-label={t("communityInvite.dismissForever")}
            onClick={() => props.onDismiss()}
          >
            <Icon name="x" />
          </button>
        </div>
        <div class="invite__body">
          <h2 class="invite__title" id="community-invite-title">
            {t("communityInvite.title")}
          </h2>
          <p class="invite__text">{t("communityInvite.body")}</p>
          <div class="invite__links" dir="ltr">
            <For each={communityLinks}>
              {(link) => (
                <a
                  class="invite__cta"
                  href={link.href}
                  aria-label={t("communityInvite.joinPlatform", { platform: link.platform })}
                  title={t("communityInvite.joinPlatform", { platform: link.platform })}
                  target={EXTERNAL_LINK_TARGET}
                  rel={buildExternalLinkRel()}
                >
                  <BrandIcon name={link.icon} />
                  <span>{t(`communityInvite.${link.label}`)}</span>
                </a>
              )}
            </For>
          </div>
        </div>
      </aside>
    </div>
  );
}
