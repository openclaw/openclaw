import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { RouteId } from "../../app-route-paths.ts";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { NativeChromeSetup } from "../../components/native-chrome-setup.tsx";
import { BrandIcon, Icon } from "../../components/solid/icon.tsx";
import { registerAppsEnglish } from "../../i18n/locales/en-apps.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import "../../styles/apps.css";
import { COMMUNITY_DISCORD_URL } from "../../lib/product-links.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerAppsEnglish);

function filledIcon(path: string, fillRule?: "evenodd") {
  return () => (
    <svg viewBox="0 0 24 24" class="icon--filled">
      <path fill-rule={fillRule} d={path} />
    </svg>
  );
}

// Apps-only platform marks; apps.css fills .icon--filled and strokes the other glyphs.
const appsBrandIcons = {
  watch: () => (
    <svg viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="6" />
      <polyline points="12 10 12 12 13 13" />
      <path d="m16.13 7.66-.81-4.05a2 2 0 0 0-2-1.61h-2.68a2 2 0 0 0-2 1.61l-.78 4.05" />
      <path d="m7.88 16.36.8 4a2 2 0 0 0 2 1.61h2.72a2 2 0 0 0 2-1.61l.81-4.05" />
    </svg>
  ),
  apple: filledIcon(
    "M17.05 12.54c-.03-2.62 2.14-3.88 2.24-3.94-1.22-1.79-3.12-2.03-3.8-2.06-1.61-.16-3.15.95-3.97.95-.82 0-2.08-.93-3.42-.9-1.76.03-3.38 1.02-4.29 2.6-1.83 3.17-.47 7.87 1.31 10.44.87 1.26 1.91 2.67 3.27 2.62 1.31-.05 1.81-.85 3.4-.85 1.58 0 2.03.85 3.42.82 1.41-.02 2.31-1.28 3.17-2.55.99-1.46 1.4-2.87 1.42-2.94-.03-.02-2.73-1.05-2.75-4.19Zm-2.6-7.68c.72-.88 1.21-2.09 1.08-3.3-1.04.04-2.3.69-3.05 1.56-.67.78-1.26 2.02-1.1 3.2 1.16.09 2.34-.59 3.07-1.46Z",
  ),
  android: filledIcon(
    "M17.52 15.05a.98.98 0 1 1 .01-1.96.98.98 0 0 1-.01 1.96m-11.04 0a.98.98 0 1 1 .01-1.96.98.98 0 0 1-.01 1.96m11.39-5.89 1.96-3.39a.4.4 0 0 0-.15-.55.4.4 0 0 0-.55.15l-1.98 3.43A12.03 12.03 0 0 0 12 7.75c-1.85 0-3.6.42-5.15 1.05L4.87 5.37a.4.4 0 0 0-.55-.15.4.4 0 0 0-.15.55l1.96 3.39C2.75 11 .48 14.42.14 18.4h23.72c-.34-3.98-2.61-7.4-5.99-9.24",
  ),
  windows: filledIcon(
    "M3 5.55 10.29 4.5v7.02H3V5.55Zm0 12.9 7.29 1.05v-6.93H3v5.88Zm8.09 1.16L21 21v-8.43h-9.91v7.04Zm0-15.22v7.13H21V3l-9.91 1.39Z",
  ),
  linux: filledIcon(
    "M12 2c-2.76 0-5 2.24-5 5v3.1c0 1.35-.62 2.5-1.32 3.6C4.6 15.4 4 16.9 4 18.3 4 20.9 7.58 22 12 22s8-1.1 8-3.7c0-1.4-.6-2.9-1.68-4.6-.7-1.1-1.32-2.25-1.32-3.6V7c0-2.76-2.24-5-5-5Zm-2 4.5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm4 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2Zm-2 2.7 1.8 1.3c.3.24.3.7-.02.92L12 12.6l-1.78-1.18a.58.58 0 0 1-.02-.93L12 9.2Z",
    "evenodd",
  ),
  chrome: filledIcon(
    "M12 2a10 10 0 0 1 8.66 5H12a5 5 0 0 0-4.79 3.57L4.4 5.72A9.98 9.98 0 0 1 12 2Zm9.54 7A10 10 0 0 1 12 22l-.34-.01 4.36-7.55A4.98 4.98 0 0 0 17 12c0-1.13-.37-2.16-1-3h5.54ZM3.35 7.57l4.36 7.56a5 5 0 0 0 6.16 2.24l-2.81 4.87A10 10 0 0 1 3.35 7.57ZM12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z",
  ),
} as const;

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
              class={["apps-card__art-img", `apps-card__art-img--${theme}`]}
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
          <NativeChromeSetup />
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
