import { expectDefined } from "@openclaw/normalization-core";
import { For, createMemo } from "solid-js";
import { currentThemeBranding, subscribeThemeBranding } from "../../app/theme-branding.ts";
import type { ControlUiBuildInfo } from "../../build-info.ts";
import { LobsterSvg } from "../../components/lobster-pet-artwork.tsx";
import { canonicalLobsterLook, lobsterLookStyle } from "../../components/lobster-pet-identity.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import {
  BrandIcon,
  Icon,
  type BrandIconName,
  type IconName,
} from "../../components/solid/icon.tsx";
import { SettingsPage, SettingsRow, SettingsSection } from "../../components/solid/settings-ui.tsx";
import "../../components/tooltip.ts";
import "../../components/theme-brand-icon.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { COMMUNITY_DISCORD_URL } from "../../lib/product-links.ts";
import {
  formatDateMs,
  formatDateTimeMs,
  formatRelativeTimestamp,
} from "../../lib/reactive/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import "../../styles/about.css";
import "../../styles/settings.css";

export type AboutCommitCopyState = "idle" | "copying" | "copied" | "error";
type AboutProps = {
  buildInfo: ControlUiBuildInfo;
  gatewayVersion: string | null;
  copyState: AboutCommitCopyState;
  onCopyCommit: () => void;
  clawdWaving: boolean;
  onPokeClawd: () => void;
};

const SHORT_COMMIT_LENGTH = 12;
// Docs-first where a docs page exists; GitHub/Discord match the native About screens.
type AboutLink = { href: string; labelKey: string } & (
  | { kind: "icon"; name: IconName }
  | { kind: "brand"; name: BrandIconName }
);
const ABOUT_LINKS: readonly AboutLink[] = [
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

function Unavailable() {
  return <span class="muted">{t("aboutPage.unavailable")}</span>;
}

function CommitAge(props: { commitAt: string | null }) {
  const timestamp = createMemo(() => Date.parse(props.commitAt ?? ""));
  return (
    <>
      {Number.isFinite(timestamp()) && props.commitAt ? (
        <time
          class="about-commit__age"
          dir="auto"
          datetime={props.commitAt}
          title={formatDateTimeMs(timestamp(), { dateStyle: "medium", timeStyle: "short" })}
        >
          {formatRelativeTimestamp(timestamp(), { fallback: "" })}
        </time>
      ) : undefined}
    </>
  );
}

function Commit(props: AboutProps) {
  const label = createMemo(() =>
    t(
      {
        idle: "aboutPage.copyCommit",
        copying: "aboutPage.copyingCommit",
        copied: "aboutPage.copiedCommit",
        error: "aboutPage.copyCommitFailed",
      }[props.copyState],
    ),
  );
  return (
    <>
      {props.buildInfo.commit ? (
        <span class="about-commit">
          <code dir="ltr" title={props.buildInfo.commit}>
            {props.buildInfo.commit.slice(0, SHORT_COMMIT_LENGTH)}
          </code>
          <CommitAge commitAt={props.buildInfo.commitAt} />
          <openclaw-tooltip prop:content={label()}>
            <button
              type="button"
              class="about-commit__copy"
              aria-label={label()}
              aria-busy={props.copyState === "copying" ? "true" : undefined}
              disabled={props.copyState === "copying"}
              onClick={() => props.onCopyCommit()}
            >
              <span aria-hidden="true">
                <Icon name={props.copyState === "copied" ? "check" : "copy"} />
              </span>
            </button>
          </openclaw-tooltip>
          <span class="sr-only" role="status" aria-live="polite">
            {props.copyState === "copied" || props.copyState === "error" ? label() : ""}
          </span>
        </span>
      ) : (
        <Unavailable />
      )}
    </>
  );
}

export function AboutView(props: AboutProps) {
  const branding = projectSource(undefined, {
    read: currentThemeBranding,
    subscribe: (_source, notify) => subscribeThemeBranding(notify),
    equality: Object.is,
  });
  const palette =
    LOBSTER_PET_PALETTES.find((entry) => entry.id === "crimson") ??
    expectDefined(LOBSTER_PET_PALETTES[0], "about lobster palette");
  const look = canonicalLobsterLook(palette);
  const buildDate = createMemo(() =>
    formatDateMs(
      Date.parse(props.buildInfo.builtAt ?? ""),
      { dateStyle: "medium", timeZone: "UTC" },
      "",
    ),
  );
  return (
    <SettingsPage>
      <section class="about-hero">
        {branding.read().brandIcon !== "claw" ? (
          <span class="about-hero__mark--neutral" aria-hidden="true">
            <openclaw-theme-brand-icon prop:branding={branding.read()} aria-hidden="true" />
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
      <SettingsSection
        title={t("aboutPage.artifactTitle")}
        description={t("aboutPage.artifactSubtitle")}
      >
        <dl class="settings-kv about-build-grid" aria-label={t("aboutPage.artifactDetails")}>
          <dt>{t("aboutPage.version")}</dt>
          <dd>
            {props.buildInfo.version ? (
              <code dir="ltr" title={props.buildInfo.version}>
                {props.buildInfo.version}
              </code>
            ) : (
              <Unavailable />
            )}
          </dd>
          <dt>{t("aboutPage.commit")}</dt>
          <dd>
            <Commit {...props} />
          </dd>
          {props.buildInfo.branch && (
            <>
              <dt>{t("aboutPage.branch")}</dt>
              <dd>
                <code dir="ltr" title={props.buildInfo.branch}>
                  {props.buildInfo.branch}
                  {props.buildInfo.dirty === true ? "*" : ""}
                </code>
              </dd>
            </>
          )}
          <dt>{t("aboutPage.built")}</dt>
          <dd>
            {buildDate() && props.buildInfo.builtAt ? (
              <time dir="auto" datetime={props.buildInfo.builtAt} title={props.buildInfo.builtAt}>
                {buildDate()}
              </time>
            ) : (
              <Unavailable />
            )}
          </dd>
        </dl>
      </SettingsSection>
      <SettingsSection>
        <SettingsRow
          title={t("aboutPage.gatewayVersion")}
          description={t("aboutPage.gatewayVersionHint")}
          control={
            <span
              class={[
                "settings-row__value",
                { "settings-row__value--mono": Boolean(props.gatewayVersion) },
              ]}
            >
              {props.gatewayVersion ? (
                <code dir="ltr" title={props.gatewayVersion}>
                  {props.gatewayVersion}
                </code>
              ) : (
                t("aboutPage.unavailable")
              )}
            </span>
          }
        />
      </SettingsSection>
      <p class="about-footer">{t("aboutPage.license")}</p>
    </SettingsPage>
  );
}
