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
    label: () => t("communityInvite.join"),
    accessibleLabel: () => t("communityInvite.joinPlatform", { platform: "Reddit" }),
    href: "https://www.reddit.com/r/openclaw/",
    icon: brandIcons.reddit,
  },
  {
    label: () => t("communityInvite.join"),
    accessibleLabel: () => t("communityInvite.joinPlatform", { platform: "Discord" }),
    href: COMMUNITY_DISCORD_URL,
    icon: brandIcons.discord,
  },
  {
    label: () => t("communityInvite.follow"),
    accessibleLabel: () => t("communityInvite.followPlatform", { platform: "X" }),
    href: "https://x.com/openclaw",
    icon: brandIcons.x,
  },
];

export function renderCommunityInviteCard(onDismiss: () => void, mode: "light" | "dark") {
  return html`
    <div class="community-invite-card">
      <aside class="invite" role="complementary" aria-labelledby="community-invite-title">
        <div class="invite__header">
          <img
            class="invite__art"
            src=${inferControlUiPublicAssetPath(`community-art/community-invite-${mode}.webp`)}
            alt=""
            width="1024"
            height="512"
            loading="lazy"
            decoding="async"
          />
          <div class="invite__marks" dir="ltr" aria-hidden="true">
            ${communityLinks.map((link) => link.icon)}
          </div>
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
                  aria-label=${link.accessibleLabel()}
                  title=${link.accessibleLabel()}
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
