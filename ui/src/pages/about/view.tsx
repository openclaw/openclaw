import { expectDefined } from "@openclaw/normalization-core";
import { For, Show, createMemo } from "solid-js";
import type { ControlUiBuildInfo } from "../../build-info.ts";
import { LobsterSvg } from "../../components/lobster-pet-artwork.tsx";
import { canonicalLobsterLook, lobsterLookStyle } from "../../components/lobster-pet-identity.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import {
  BrandIcon,
  Icon,
  type BrandIconName,
  type IconName,
} from "../../components/solid/icon.tsx";
import { SettingsPage, SettingsSection } from "../../components/solid/settings-ui.tsx";
import { ThemeBrandIcon } from "../../components/theme-brand-icon.tsx";
import { registerAboutEnglish } from "../../i18n/locales/en-about.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { COMMUNITY_DISCORD_URL, OFFICIAL_SUPPORT_URL } from "../../lib/product-links.ts";
import { formatDateTimeMs } from "../../lib/reactive/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { themeBrandingProjection } from "../../lib/reactive/theme-branding.ts";
import "../../styles/about.css";
import "../../styles/settings.css";

registerAboutEnglish();

/** Identity facts rendered for one running artifact. Missing facts are omitted. */
type AboutBuild = {
  version: string | null;
  commit: string | null;
  builtAt: string | null;
  branch?: string | null;
  dirty?: boolean | null;
};

type AboutProps = {
  buildInfo: ControlUiBuildInfo;
  gateway: AboutBuild;
  clawdWaving: boolean;
  onPokeClawd: () => void;
};

const SHORT_COMMIT_LENGTH = 7;
// Keep official support distinct from self-service docs and social links.
type AboutLink = { href: string; labelKey: string } & (
  | { kind: "icon"; name: IconName }
  | { kind: "brand"; name: BrandIconName }
);
const ABOUT_LINKS: readonly AboutLink[] = [
  {
    href: OFFICIAL_SUPPORT_URL,
    kind: "icon",
    name: "messageSquare",
    labelKey: "aboutPage.linkSupport",
  },
  { href: "https://openclaw.ai", kind: "icon", name: "globe", labelKey: "aboutPage.linkWebsite" },
  { href: "https://docs.openclaw.ai", kind: "icon", name: "book", labelKey: "aboutPage.linkDocs" },
  {
    href: "https://github.com/openclaw/openclaw",
    kind: "brand",
    name: "github",
    labelKey: "aboutPage.linkGitHub",
  },
  {
    href: COMMUNITY_DISCORD_URL,
    kind: "brand",
    name: "discord",
    labelKey: "aboutPage.linkDiscord",
  },
  { href: "https://x.com/openclaw", kind: "brand", name: "x", labelKey: "aboutPage.linkX" },
  {
    href: "https://docs.openclaw.ai/releases",
    kind: "icon",
    name: "scrollText",
    labelKey: "aboutPage.linkChangelog",
  },
];

const BUILT_AT_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
};

function Unavailable() {
  return <span class="muted">{t("aboutPage.unavailable")}</span>;
}

function BuildFacts(props: { title: string; label: string; build: AboutBuild }) {
  const builtAt = createMemo(() =>
    formatDateTimeMs(Date.parse(props.build.builtAt ?? ""), BUILT_AT_FORMAT, ""),
  );
  return (
    <SettingsSection title={props.title}>
      <dl class="settings-kv about-build-grid" aria-label={props.label}>
        <dt>{t("aboutPage.version")}</dt>
        <dd>
          <Show when={props.build.version} fallback={<Unavailable />}>
            {(version) => (
              <code dir="ltr" title={version()}>
                {version()}
              </code>
            )}
          </Show>
        </dd>
        <Show when={props.build.commit}>
          {(commit) => (
            <>
              <dt>{t("aboutPage.commit")}</dt>
              <dd>
                <span class="about-commit">
                  <code dir="ltr" title={commit()}>
                    {commit().slice(0, SHORT_COMMIT_LENGTH)}
                  </code>
                  <CopyButton text={commit()} idleLabel={t("aboutPage.copyCommit")} />
                </span>
              </dd>
            </>
          )}
        </Show>
        <Show when={props.build.branch}>
          {(branch) => (
            <>
              <dt>{t("aboutPage.branch")}</dt>
              <dd>
                <code dir="ltr" title={branch()}>
                  {branch()}
                  {props.build.dirty === true ? "*" : ""}
                </code>
              </dd>
            </>
          )}
        </Show>
        <Show when={builtAt() && props.build.builtAt}>
          {(iso) => (
            <>
              <dt>{t("aboutPage.built")}</dt>
              <dd>
                <time dir="auto" datetime={iso()} title={iso()}>
                  {builtAt()}
                </time>
              </dd>
            </>
          )}
        </Show>
      </dl>
    </SettingsSection>
  );
}

export function AboutView(props: AboutProps) {
  const branding = themeBrandingProjection;
  const palette =
    LOBSTER_PET_PALETTES.find((entry) => entry.id === "crimson") ??
    expectDefined(LOBSTER_PET_PALETTES[0], "about lobster palette");
  const look = canonicalLobsterLook(palette);
  return (
    <SettingsPage>
      <section class="about-hero">
        {branding.read().brandIcon !== "claw" ? (
          <span class="about-hero__mark--neutral" aria-hidden="true">
            <ThemeBrandIcon branding={branding.read()} aria-hidden="true" />
          </span>
        ) : (
          <button
            type="button"
            class={["about-hero__clawd", { "about-hero__clawd--wave": props.clawdWaving }]}
            style={lobsterLookStyle(look)}
            aria-label={t("aboutPage.waveHello")}
            onClick={() => props.onPokeClawd()}
          >
            <LobsterSvg look={look} />
          </button>
        )}
        <h2 class="about-hero__name">{branding.read().brandName}</h2>
        <p class="about-hero__tagline">{t("aboutPage.tagline")}</p>
        {props.buildInfo.version && (
          <code class="about-hero__version" dir="ltr">
            v{props.buildInfo.version}
          </code>
        )}
        <nav class="about-hero__links" aria-label={t("aboutPage.linksLabel")}>
          <For each={branding.read().communityLinks ? ABOUT_LINKS : []}>
            {(link) => (
              <a
                class="about-hero__link"
                href={link.href}
                target={EXTERNAL_LINK_TARGET}
                rel={buildExternalLinkRel()}
              >
                <span class="about-hero__link-icon" aria-hidden="true">
                  {link.kind === "brand" ? (
                    <BrandIcon name={link.name} />
                  ) : (
                    <Icon name={link.name} />
                  )}
                </span>
                <span>{t(link.labelKey)}</span>
              </a>
            )}
          </For>
        </nav>
      </section>
      <BuildFacts
        title={t("aboutPage.artifactTitle")}
        label={t("aboutPage.artifactDetails")}
        build={props.buildInfo}
      />
      <BuildFacts
        title={t("aboutPage.gateway")}
        label={t("aboutPage.gateway")}
        build={props.gateway}
      />
      <p class="about-footer">{t("aboutPage.license")}</p>
    </SettingsPage>
  );
}
