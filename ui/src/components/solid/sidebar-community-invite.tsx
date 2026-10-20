import { createSignal, createUniqueId, Errored, For, lazy, Loading, Show } from "solid-js";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { COMMUNITY_DISCORD_URL } from "../../lib/product-links.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { BrandIcon, Icon } from "./icon.tsx";
import { LazyViewError } from "./lazy-view-error.tsx";
import { LoadingState } from "./loading-state.tsx";
import "../../styles/community-invite-card.css";

// Keep the native dialog policy off the sidebar's startup path.
const ModalDialog = lazy(() => import("../modal-dialog.ts"), { export: "ModalDialog" });
const communityLinks = [
  {
    platform: "Discord",
    descriptionKey: "communityInvite.discord",
    label: "join",
    href: COMMUNITY_DISCORD_URL,
    icon: "discord",
  },
  {
    platform: "Reddit",
    descriptionKey: "communityInvite.reddit",
    label: "join",
    href: "https://www.reddit.com/r/openclaw/",
    icon: "reddit",
  },
  {
    platform: "X",
    descriptionKey: "communityInvite.x",
    label: "follow",
    href: "https://x.com/openclaw",
    icon: "x",
  },
] as const;

export function SidebarCommunityInvite() {
  const [open, setOpen] = createSignal(false);
  const id = createUniqueId();
  return (
    <>
      <openclaw-tooltip prop:content={t("communityInvite.title")} prop:placement="right">
        <button
          type="button"
          class="sidebar-rail__button sidebar-community__entry"
          aria-label={t("communityInvite.title")}
          aria-haspopup="dialog"
          aria-expanded={open() ? "true" : "false"}
          aria-controls={id}
          onClick={() => setOpen(true)}
        >
          <Icon name="users" />
        </button>
      </openclaw-tooltip>
      <Show when={open()}>
        <Errored
          fallback={(error, reset) => (
            <LazyViewError error={error()} onRetry={reset} onClose={() => setOpen(false)} inline />
          )}
        >
          <Loading fallback={<LoadingState />}>
            <ModalDialog
              id={id}
              class="sidebar-community-dialog"
              label={t("communityInvite.title")}
              description={t("communityInvite.body")}
              onModal-cancel={() => setOpen(false)}
            >
              <section class="sidebar-community__panel">
                <div class="sidebar-community__grabber" aria-hidden="true" />
                <div class="sidebar-community__header">
                  <h2>{t("communityInvite.title")}</h2>
                  <button
                    type="button"
                    class="sidebar-community__close"
                    aria-label={t("common.close")}
                    onClick={() => setOpen(false)}
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
                        aria-label={t(`communityInvite.${link.label}Platform`, {
                          platform: link.platform,
                        })}
                      >
                        <BrandIcon name={link.icon} />
                        <span class="sidebar-community__link-copy">
                          <strong translate="no">{link.platform}</strong>
                          <span>{t(link.descriptionKey)}</span>
                        </span>
                        <Icon name="arrowUpRight" />
                      </a>
                    )}
                  </For>
                </div>
                <p class="sidebar-community__note">{t("communityInvite.opensNewTab")}</p>
              </section>
            </ModalDialog>
          </Loading>
        </Errored>
      </Show>
    </>
  );
}
