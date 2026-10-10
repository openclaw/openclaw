import { expectDefined } from "@openclaw/normalization-core";
import type { TemplateResult } from "lit";
import { For, createMemo } from "solid-js";
import { currentThemeBranding, subscribeThemeBranding } from "../../app/theme-branding.ts";
import type { ControlUiBuildInfo } from "../../build-info.ts";
import { brandIcons } from "../../components/brand-icons.ts";
import { icons } from "../../components/icons.ts";
import {
  canonicalLobsterLook,
  lobsterLookStyle,
  renderLobsterSvg,
} from "../../components/lobster-pet-look.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import "../../components/tooltip.ts";
import { renderThemeBrandIcon } from "../../components/theme-brand-icon.ts";
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
import { LitContent } from "../../lit/lit-content.tsx";

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
const ABOUT_LINKS: ReadonlyArray<{ href: string; icon: TemplateResult; labelKey: string }> = [
  { href: "https://openclaw.ai", icon: icons.globe, labelKey: "aboutPage.linkWebsite" },
  { href: "https://docs.openclaw.ai", icon: icons.book, labelKey: "aboutPage.linkDocs" },
  {
    href: "https://github.com/openclaw/openclaw",
    icon: brandIcons.github,
    labelKey: "aboutPage.linkGitHub",
  },
  { href: COMMUNITY_DISCORD_URL, icon: brandIcons.discord, labelKey: "aboutPage.linkDiscord" },
  { href: "https://x.com/openclaw", icon: brandIcons.x, labelKey: "aboutPage.linkX" },
  {
    href: "https://docs.openclaw.ai/releases",
    icon: icons.scrollText,
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
                <LitContent content={props.copyState === "copied" ? icons.check : icons.copy} />
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
    <div class="settings-page">
      <section class="about-hero">
        {branding.read().brandIcon !== "claw" ? (
          <span class="about-hero__mark--neutral" aria-hidden="true">
            <LitContent content={renderThemeBrandIcon(undefined, branding.read())} />
          </span>
        ) : (
          <button
            type="button"
            class={["about-hero__clawd", { "about-hero__clawd--wave": props.clawdWaving }]}
            style={lobsterLookStyle(look)}
            aria-label={t("aboutPage.waveHello")}
            onClick={() => props.onPokeClawd()}
          >
            <LitContent content={renderLobsterSvg(look)} />
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
                  <LitContent content={link.icon} />
                </span>
                <span>{t(link.labelKey)}</span>
              </a>
            )}
          </For>
        </nav>
      </section>
      <section class="settings-section">
        <div class="settings-section__header">
          <div class="settings-section__copy">
            <h2 class="settings-section__heading">{t("aboutPage.artifactTitle")}</h2>
            <p class="settings-section__desc">{t("aboutPage.artifactSubtitle")}</p>
          </div>
        </div>
        <div class="settings-group">
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
        </div>
      </section>
      <section class="settings-section">
        <div class="settings-group">
          <div class="settings-row">
            <div class="settings-row__text">
              <span class="settings-row__title">{t("aboutPage.gatewayVersion")}</span>
              <span class="settings-row__desc">{t("aboutPage.gatewayVersionHint")}</span>
            </div>
            <div class="settings-row__control">
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
            </div>
          </div>
        </div>
      </section>
      <p class="about-footer">{t("aboutPage.license")}</p>
    </div>
  );
}
