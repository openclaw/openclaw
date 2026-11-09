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
import { SettingsGroup, SettingsPage } from "../../components/solid/settings-ui.tsx";
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
  { href: "https://docs.openclaw.ai", kind: "icon", name: "book", labelKey: "aboutPage.linkDocs" },
  {
    href: "https://docs.openclaw.ai/releases",
    kind: "icon",
    name: "scrollText",
    labelKey: "aboutPage.linkChangelog",
  },
  { href: "https://openclaw.ai", kind: "icon", name: "globe", labelKey: "aboutPage.linkWebsite" },
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

/** What a report needs to name this build: version and full commit, or whichever exists. */
function buildReport(build: AboutBuild): string | null {
  if (build.version && build.commit) {
    return `${build.version} (${build.commit})`;
  }
  return build.version || build.commit;
}

/** One running artifact: its name, then its facts as a line the eye can read as an identity. */
function BuildRow(props: { title: string; label: string; build: AboutBuild }) {
  const builtAt = createMemo(() =>
    formatDateTimeMs(Date.parse(props.build.builtAt ?? ""), BUILT_AT_FORMAT, ""),
  );
  return (
    <div class="settings-row about-build">
      <div class="settings-row__text">
        <span class="settings-row__title">{props.title}</span>
        <dl class="about-build__facts" aria-label={props.label}>
          <div class="about-build__fact about-build__fact--version">
            <dt class="sr-only">{t("aboutPage.version")}</dt>
            <dd>
              <Show when={props.build.version} fallback={t("aboutPage.unavailable")}>
                {(version) => (
                  <code dir="ltr" title={version()}>
                    {version()}
                  </code>
                )}
              </Show>
            </dd>
          </div>
          <Show when={props.build.commit}>
            {(commit) => (
              <div class="about-build__fact">
                <dt class="sr-only">{t("aboutPage.commit")}</dt>
                <dd>
                  <code dir="ltr" title={commit()}>
                    {commit().slice(0, SHORT_COMMIT_LENGTH)}
                  </code>
                </dd>
              </div>
            )}
          </Show>
          <Show when={props.build.branch}>
            {(branch) => (
              <div class="about-build__fact">
                <dt class="sr-only">{t("aboutPage.branch")}</dt>
                <dd>
                  <code dir="ltr" title={branch()}>
                    {branch()}
                    {props.build.dirty === true ? "*" : ""}
                  </code>
                </dd>
              </div>
            )}
          </Show>
          <Show when={builtAt() && props.build.builtAt}>
            {(iso) => (
              <div class="about-build__fact">
                <dt class="sr-only">{t("aboutPage.built")}</dt>
                <dd>
                  <time dir="auto" datetime={iso()} title={iso()}>
                    {builtAt()}
                  </time>
                </dd>
              </div>
            )}
          </Show>
        </dl>
      </div>
      <Show when={buildReport(props.build)}>
        {(report) => (
          <div class="settings-row__control">
            <CopyButton text={report()} idleLabel={t("aboutPage.copyBuild")} />
          </div>
        )}
      </Show>
    </div>
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
      <section class="about-identity">
        {branding.read().brandIcon !== "claw" ? (
          <span class="about-identity__mark" aria-hidden="true">
            <ThemeBrandIcon branding={branding.read()} aria-hidden="true" />
          </span>
        ) : (
          <button
            type="button"
            class={["about-identity__clawd", { "about-identity__clawd--wave": props.clawdWaving }]}
            style={lobsterLookStyle(look)}
            aria-label={t("aboutPage.waveHello")}
            onClick={() => props.onPokeClawd()}
          >
            <LobsterSvg look={look} />
          </button>
        )}
        <div class="about-identity__text">
          <h2 class="about-identity__name">{branding.read().brandName}</h2>
          <p class="about-identity__tagline">{t("aboutPage.tagline")}</p>
        </div>
      </section>
      <SettingsGroup>
        <BuildRow
          title={t("aboutPage.artifactTitle")}
          label={t("aboutPage.artifactDetails")}
          build={props.buildInfo}
        />
        <BuildRow
          title={t("aboutPage.gateway")}
          label={t("aboutPage.gateway")}
          build={props.gateway}
        />
      </SettingsGroup>
      <Show when={branding.read().communityLinks}>
        <nav aria-label={t("aboutPage.linksLabel")}>
          <SettingsGroup>
            <For each={ABOUT_LINKS}>
              {(link) => (
                <a
                  class="settings-row settings-row--nav about-link"
                  href={link.href}
                  target={EXTERNAL_LINK_TARGET}
                  rel={buildExternalLinkRel()}
                >
                  <span class="about-link__icon" aria-hidden="true">
                    {link.kind === "brand" ? (
                      <BrandIcon name={link.name} />
                    ) : (
                      <Icon name={link.name} />
                    )}
                  </span>
                  <span class="settings-row__text">
                    <span class="settings-row__title">{t(link.labelKey)}</span>
                  </span>
                  <span class="settings-row__chevron">
                    <Icon name="arrowUpRight" />
                  </span>
                </a>
              )}
            </For>
          </SettingsGroup>
        </nav>
      </Show>
      <p class="about-footer">{t("aboutPage.license")}</p>
    </SettingsPage>
  );
}
