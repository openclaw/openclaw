import { createSignal, createUniqueId, For, onSettled, Show } from "solid-js";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
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

declare module "@solidjs/web" {
  namespace JSX {
    interface ImgHTMLAttributes<T> extends HTMLAttributes<T> {
      // Pinterest documents this nonstandard per-image saving opt-out.
      nopin?: "nopin";
    }
  }
}

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
      <div class="community-invite-card">
        <aside class="invite" role="complementary" aria-labelledby={titleId}>
          <div class="invite__header">
            <img
              class="invite__art"
              src={inferControlUiPublicAssetPath(
                `community-art/community-invite-${props.mode}.webp`,
              )}
              alt=""
              nopin="nopin"
              data-pin-nopin="true"
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
              onClick={dismiss}
            >
              <Icon name="x" />
            </button>
          </div>
          <div class="invite__body">
            <h2 class="invite__title" id={titleId}>
              {t("communityInvite.title")}
            </h2>
            <p class="invite__text">{t("communityInvite.body")}</p>
            <div class="invite__links" dir="ltr">
              <For each={communityLinks}>
                {(link) => (
                  <a
                    class="invite__cta"
                    href={link.href}
                    aria-label={t(`communityInvite.${link.label}Platform`, {
                      platform: link.platform,
                    })}
                    title={t(`communityInvite.${link.label}Platform`, { platform: link.platform })}
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
    </Show>
  );
}
