import { html } from "lit";
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { t } from "../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../lib/external-link.ts";
import { COMMUNITY_DISCORD_URL } from "../lib/product-links.ts";
import "../styles/community-invite-card.css";
import { brandIcons } from "./brand-icons.ts";
import { icons } from "./icons.ts";

const communityLinks = [
  {
    label: () => t("communityInvite.reddit"),
    href: "https://www.reddit.com/r/openclaw/",
    icon: brandIcons.reddit,
  },
  {
    label: () => t("communityInvite.discord"),
    href: COMMUNITY_DISCORD_URL,
    icon: brandIcons.discord,
  },
  { label: () => t("communityInvite.x"), href: "https://x.com/openclaw", icon: brandIcons.x },
];

export function renderCommunityInviteCard(onDismiss: () => void) {
  return html`
    <div class="community-invite-card">
      <aside class="invite" role="complementary" aria-labelledby="community-invite-title">
        <div class="invite__header">
          <img
            class="invite__art"
            src=${inferControlUiPublicAssetPath("community-art/community-invite.webp")}
            alt=""
            width="768"
            height="320"
            loading="lazy"
            decoding="async"
          />
          <button
            class="invite__close"
            type="button"
            aria-label=${t("communityInvite.dismissForever")}
            @click=${onDismiss}
          >
            ${icons.x}
          </button>
        </div>
        <div class="invite__body">
          <h2 class="invite__title" id="community-invite-title">${t("communityInvite.title")}</h2>
          <p class="invite__text">${t("communityInvite.body")}</p>
          <div class="invite__links" dir="ltr">
            ${communityLinks.map(
              (link) => html`
                <a
                  class="invite__cta"
                  href=${link.href}
                  target=${EXTERNAL_LINK_TARGET}
                  rel=${buildExternalLinkRel()}
                >
                  ${link.icon}<span>${link.label()}</span>
                </a>
              `,
            )}
          </div>
        </div>
      </aside>
    </div>
  `;
}
