// Control UI view renders the Apps & extensions promo page.
import { html, nothing, type TemplateResult } from "lit";
import type { RouteId } from "../../app-route-paths.ts";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerAppsEnglish } from "../../i18n/locales/en-apps.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { COMMUNITY_DISCORD_URL } from "../../lib/product-links.ts";
import "../../styles/apps.css";
import "../../components/native-chrome-setup.ts";
import { brandIcons } from "../about/brand-icons.ts";
import { appsBrandIcons } from "./brand-icons.ts";

registerAppsEnglish();

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
  icon: TemplateResult;
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
const docsCta = (path: string) => externalCta(`https://docs.openclaw.ai${path}`, "appsPage.ctaDocs");

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
          externalCta("https://apps.apple.com/app/openclaw-ai-that-does-things/id6780396132", "appsPage.ctaAppStore"),
          docsCta("/platforms/ios"),
        ],
      },
      {
        id: "android",
        gradient: ["#34d399", "#047857"],
        icon: appsBrandIcons.android,
        copyKey: "appsPage.cards.android",
        ctas: [
          externalCta("https://play.google.com/store/apps/details?id=ai.openclaw.app", "appsPage.ctaPlayStore"),
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
          externalCta("https://github.com/openclaw/openclaw-windows-node/releases/latest", "appsPage.ctaDownload"),
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
          externalCta("https://chromewebstore.google.com/detail/openclaw/kcdjddhmeafeomebliikmbpblkmkfoig", "appsPage.ctaChromeWebStore"),
          externalCta("https://docs.openclaw.ai/tools/chrome-extension", "appsPage.ctaSetupGuide"),
        ],
      },
      {
        id: "plugins",
        gradient: ["#fb7185", "#9f1239"],
        icon: icons.plug,
        copyKey: "appsPage.cards.plugins",
        ctas: [
          { kind: "internal", routeId: "plugins", labelKey: "appsPage.ctaOpenPlugins" },
          externalCta("https://clawhub.ai", "appsPage.ctaBrowseClawHub"),
        ],
      },
    ],
  },
];

const COMMUNITY_LINKS: ReadonlyArray<{ href: string; icon: TemplateResult; labelKey: string }> =
  [
    {
      href: COMMUNITY_DISCORD_URL,
      icon: brandIcons.discord,
      labelKey: "appsPage.linkDiscord",
    },
    { href: "https://docs.openclaw.ai", icon: icons.book, labelKey: "appsPage.linkDocs" },
  ];

function renderCta(cta: AppCardCta, index: number, props: AppsProps) {
  const className = index === 0 ? "apps-card__cta apps-card__cta--primary" : "apps-card__cta";
  if (cta.kind === "internal") {
    return html`
      <button type="button" class=${className} @click=${() => props.onNavigate(cta.routeId)}>
        ${t(cta.labelKey)}
      </button>
    `;
  }
  return html`
    <a
      class=${className}
      href=${cta.href}
      target=${EXTERNAL_LINK_TARGET}
      rel=${buildExternalLinkRel()}
    >
      ${t(cta.labelKey)}
    </a>
  `;
}

function renderAppCard(card: AppCard, props: AppsProps) {
  const [from, to] = card.gradient;
  const macGatewayLaunchUrl = card.id === "macos" ? props.macGatewayLaunchUrl : null;
  return html`
    <article class="apps-card">
      <div class="apps-card__art" style=${`--apps-art-a:${from};--apps-art-b:${to}`}>
        ${["light", "dark"].map(
          (theme) => html`<img
            class="apps-card__art-img apps-card__art-img--${theme}"
            src=${inferControlUiPublicAssetPath(`app-art/${card.id}${theme === "dark" ? "-dark" : ""}.webp`)}
            alt=""
            loading="lazy"
            decoding="async"
          />`,
        )}
      </div>
      <div class="apps-card__body">
        <div class="apps-card__title-row">
          <span class="apps-card__icon" aria-hidden="true">${card.icon}</span>
          <h3 class="apps-card__title">${t(`${card.copyKey}.title`)}</h3>
          ${card.badge ? html`<span class="apps-card__badge">${t(card.badge)}</span>` : nothing}
        </div>
        <p class="apps-card__desc">${t(`${card.copyKey}.desc`)}</p>
        <div class="apps-card__ctas">
          ${
            macGatewayLaunchUrl
              ? html`<a class="apps-card__cta apps-card__cta--primary" href=${macGatewayLaunchUrl}>
                  ${t("appsPage.ctaOpenMac")}
                </a>`
              : nothing
          }
          ${card.ctas.map((cta, index) => renderCta(cta, index + (macGatewayLaunchUrl ? 1 : 0), props))}
        </div>
        ${card.id === "chrome-extension" ? html`<openclaw-native-chrome-setup></openclaw-native-chrome-setup>` : nothing}
      </div>
    </article>
  `;
}

function renderSection(section: AppSection, props: AppsProps) {
  const pairHint =
    section.id === "mobile" && props.onPairDevice
      ? html`
          <p class="apps-pair-hint">
            ${t("appsPage.havePhone")}
            <button type="button" @click=${props.onPairDevice}>${t("appsPage.pairDevice")}</button>
          </p>
        `
      : nothing;
  return html`
    <section class="apps-section" aria-label=${t(section.labelKey)}>
      <h2 class="apps-section__heading">${t(section.labelKey)}</h2>
      <div class="apps-grid">${section.cards.map((card) => renderAppCard(card, props))}</div>
      ${pairHint}
    </section>
  `;
}

function renderCommunity() {
  return html`
    <section class="apps-section" aria-label=${t("appsPage.sectionCommunity")}>
      <h2 class="apps-section__heading">${t("appsPage.sectionCommunity")}</h2>
      <nav class="apps-community" aria-label=${t("appsPage.sectionCommunity")}>
        ${COMMUNITY_LINKS.map(
          (link) => html`
            <a
              class="apps-pill"
              href=${link.href}
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
            >
              <span class="apps-pill__icon" aria-hidden="true">${link.icon}</span>
              <span>${t(link.labelKey)}</span>
            </a>
          `,
        )}
      </nav>
    </section>
  `;
}

export function renderApps(props: AppsProps) {
  return html`
    <div class="apps-page">
      <section class="apps-hero">
        <h1 class="apps-hero__title">${t("appsPage.heroTitle")}</h1>
        <p class="apps-hero__tagline">${t("appsPage.heroTagline")}</p>
      </section>
      ${APP_SECTIONS.map((section) => renderSection(section, props))} ${renderCommunity()}
    </div>
  `;
}
