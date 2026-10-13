import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { RouteId } from "../../app-route-paths.ts";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { BrandIcon, Icon } from "../../components/solid/icon.tsx";
import { registerAppsEnglish } from "../../i18n/locales/en-apps.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { COMMUNITY_DISCORD_URL } from "../../lib/product-links.ts";
import "../../styles/apps.css";
import "../../components/native-chrome-setup.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { appsBrandIcons } from "./brand-icons.tsx";

registerEnglishCatalog(registerAppsEnglish);

type AppsProps = {
  onNavigate: (routeId: RouteId) => void;
  macGatewayLaunchUrl?: string | null;
  /** Opens the device-pairing dialog; absent when the operator cannot pair. */
  onPairDevice?: () => void;
};

type AppCardCta =
  | { kind: "external"; href: string; labelKey: string }
  | { kind: "internal"; routeId: RouteId; labelKey: string };

type AppCard = {
  id: string;
  /** Two-stop gradient behind the card art; also covers image load latency. */
  gradient: readonly [string, string];
  icon: () => JSX.Element;
  copyKey: string;
  badge?: string;
  ctas: readonly AppCardCta[];
};

type AppSection = {
  id: string;
  labelKey: string;
  cards: readonly AppCard[];
};

const externalCta = (href: string, labelKey: string): AppCardCta => ({
  kind: "external",
  href,
  labelKey,
});
const docsCta = (path: string) =>
  externalCta(`https://docs.openclaw.ai${path}`, "appsPage.ctaDocs");

const APP_SECTIONS: readonly AppSection[] = [
  {
    id: "mobile",
    labelKey: "appsPage.sectionMobile",
    cards: [
      {
        id: "ios",
        gradient: ["#38bdf8", "#1d4ed8"],
        icon: appsBrandIcons.apple,
        copyKey: "appsPage.cards.ios",
        ctas: [
          externalCta(
            "https://apps.apple.com/app/openclaw-ai-that-does-things/id6780396132",
            "appsPage.ctaAppStore",
          ),
          docsCta("/platforms/ios"),
        ],
      },
      {
        id: "android",
        gradient: ["#34d399", "#047857"],
        icon: appsBrandIcons.android,
        copyKey: "appsPage.cards.android",
        ctas: [
          externalCta(
            "https://play.google.com/store/apps/details?id=ai.openclaw.app",
            "appsPage.ctaPlayStore",
          ),
          docsCta("/platforms/android"),
        ],
      },
    ],
  },
  {
    id: "watch",
    labelKey: "appsPage.sectionWatch",
    cards: [
      {
        id: "apple-watch",
        gradient: ["#f472b6", "#be185d"],
        icon: appsBrandIcons.watch,
        copyKey: "appsPage.cards.appleWatch",
        badge: "appsPage.badgeBundledIos",
        ctas: [docsCta("/platforms/ios")],
      },
      {
        id: "wear-os",
        gradient: ["#22d3ee", "#0e7490"],
        icon: appsBrandIcons.watch,
        copyKey: "appsPage.cards.wearOs",
        badge: "appsPage.badgeBundledAndroid",
        ctas: [docsCta("/platforms/android")],
      },
    ],
  },
  {
    id: "desktop",
    labelKey: "appsPage.sectionDesktop",
    cards: [
      {
        id: "macos",
        gradient: ["#a855f7", "#6b21a8"],
        icon: appsBrandIcons.apple,
        copyKey: "appsPage.cards.macos",
        ctas: [
          externalCta("https://github.com/openclaw/openclaw/releases", "appsPage.ctaDownload"),
          docsCta("/platforms/macos"),
        ],
      },
      {
        id: "windows",
        gradient: ["#818cf8", "#4338ca"],
        icon: appsBrandIcons.windows,
        copyKey: "appsPage.cards.windows",
        ctas: [
          externalCta(
            "https://github.com/openclaw/openclaw-windows-node/releases/latest",
            "appsPage.ctaDownload",
          ),
          docsCta("/platforms/windows"),
        ],
      },
      {
        id: "linux",
        gradient: ["#fbbf24", "#b45309"],
        icon: appsBrandIcons.linux,
        copyKey: "appsPage.cards.linux",
        ctas: [
          externalCta("https://github.com/openclaw/openclaw/releases", "appsPage.ctaDownload"),
          docsCta("/platforms/linux"),
        ],
      },
    ],
  },
  {
    id: "browser",
    labelKey: "appsPage.sectionBrowser",
    cards: [
      {
        id: "chrome-extension",
        gradient: ["#f59e0b", "#ea580c"],
        icon: appsBrandIcons.chrome,
        copyKey: "appsPage.cards.chrome",
        ctas: [
          externalCta(
            "https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig",
            "appsPage.ctaChromeWebStore",
          ),
          externalCta("https://docs.openclaw.ai/tools/chrome-extension", "appsPage.ctaSetupGuide"),
        ],
      },
      {
        id: "plugins",
        gradient: ["#fb7185", "#9f1239"],
        icon: () => <Icon name="plug" />,
        copyKey: "appsPage.cards.plugins",
        ctas: [
          { kind: "internal", routeId: "plugins", labelKey: "appsPage.ctaOpenPlugins" },
          externalCta("https://clawhub.ai", "appsPage.ctaBrowseClawHub"),
        ],
      },
    ],
  },
];

const COMMUNITY_LINKS: ReadonlyArray<{ href: string; icon: () => JSX.Element; labelKey: string }> =
  [
    {
      href: COMMUNITY_DISCORD_URL,
      icon: () => <BrandIcon name="discord" />,
      labelKey: "appsPage.linkDiscord",
    },
    {
      href: "https://docs.openclaw.ai",
      icon: () => <Icon name="book" />,
      labelKey: "appsPage.linkDocs",
    },
  ];

function CardCta(props: {
  cta: AppCardCta;
  primary: boolean;
  onNavigate: AppsProps["onNavigate"];
}) {
  const className = () => ["apps-card__cta", { "apps-card__cta--primary": props.primary }];
  return (
    <Show
      when={props.cta.kind === "internal" ? props.cta : undefined}
      fallback={
        <a
          class={className()}
          href={props.cta.kind === "external" ? props.cta.href : undefined}
          target={EXTERNAL_LINK_TARGET}
          rel={buildExternalLinkRel()}
        >
          {t(props.cta.labelKey)}
        </a>
      }
    >
      {(cta) => (
        <button type="button" class={className()} onClick={() => props.onNavigate(cta().routeId)}>
          {t(cta().labelKey)}
        </button>
      )}
    </Show>
  );
}

function AppCardView(props: { card: AppCard; options: AppsProps }) {
  const macGatewayLaunchUrl = () =>
    props.card.id === "macos" ? props.options.macGatewayLaunchUrl : null;
  return (
    <article class="apps-card">
      <div
        class="apps-card__art"
        style={{ "--apps-art-a": props.card.gradient[0], "--apps-art-b": props.card.gradient[1] }}
      >
        <For each={["light", "dark"]}>
          {(theme) => (
            <img
              class={`apps-card__art-img apps-card__art-img--${theme}`}
              src={inferControlUiPublicAssetPath(
                `app-art/${props.card.id}${theme === "dark" ? "-dark" : ""}.webp`,
              )}
              alt=""
              loading="lazy"
              decoding="async"
            />
          )}
        </For>
      </div>
      <div class="apps-card__body">
        <div class="apps-card__title-row">
          <span class="apps-card__icon" aria-hidden="true">
            {props.card.icon()}
          </span>
          <h3 class="apps-card__title">{t(`${props.card.copyKey}.title`)}</h3>
          <Show when={props.card.badge}>
            {(badge) => <span class="apps-card__badge">{t(badge())}</span>}
          </Show>
        </div>
        <p class="apps-card__desc">{t(`${props.card.copyKey}.desc`)}</p>
        <div class="apps-card__ctas">
          <Show when={macGatewayLaunchUrl()}>
            {(url) => (
              <a class="apps-card__cta apps-card__cta--primary" href={url()}>
                {t("appsPage.ctaOpenMac")}
              </a>
            )}
          </Show>
          <For each={props.card.ctas}>
            {(cta, index) => (
              <CardCta
                cta={cta}
                primary={index() === 0 && !macGatewayLaunchUrl()}
                onNavigate={props.options.onNavigate}
              />
            )}
          </For>
        </div>
        <Show when={props.card.id === "chrome-extension"}>
          <openclaw-native-chrome-setup />
        </Show>
      </div>
    </article>
  );
}

function AppSectionView(props: { section: AppSection; options: AppsProps }) {
  return (
    <section class="apps-section" aria-label={t(props.section.labelKey)}>
      <h2 class="apps-section__heading">{t(props.section.labelKey)}</h2>
      <div class="apps-grid">
        <For each={props.section.cards}>
          {(card) => <AppCardView card={card} options={props.options} />}
        </For>
      </div>
      <Show when={props.section.id === "mobile" && props.options.onPairDevice}>
        <p class="apps-pair-hint">
          {t("appsPage.havePhone")}{" "}
          <button type="button" onClick={() => props.options.onPairDevice?.()}>
            {t("appsPage.pairDevice")}
          </button>
        </p>
      </Show>
    </section>
  );
}

export function Apps(props: AppsProps) {
  return (
    <div class="apps-page">
      <section class="apps-hero">
        <h1 class="apps-hero__title">{t("appsPage.heroTitle")}</h1>
        <p class="apps-hero__tagline">{t("appsPage.heroTagline")}</p>
      </section>
      <For each={APP_SECTIONS}>
        {(section) => <AppSectionView section={section} options={props} />}
      </For>
      <section class="apps-section" aria-label={t("appsPage.sectionCommunity")}>
        <h2 class="apps-section__heading">{t("appsPage.sectionCommunity")}</h2>
        <nav class="apps-community" aria-label={t("appsPage.sectionCommunity")}>
          <For each={COMMUNITY_LINKS}>
            {(link) => (
              <a
                class="apps-pill"
                href={link.href}
                target={EXTERNAL_LINK_TARGET}
                rel={buildExternalLinkRel()}
              >
                <span class="apps-pill__icon" aria-hidden="true">
                  {link.icon()}
                </span>
                <span>{t(link.labelKey)}</span>
              </a>
            )}
          </For>
        </nav>
      </section>
    </div>
  );
}
