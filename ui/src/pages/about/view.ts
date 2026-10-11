import { expectDefined } from "@openclaw/normalization-core";
import { html, nothing, type TemplateResult } from "lit";
import type { ControlUiBuildInfo } from "../../build-info.ts";
import { brandIcons } from "../../components/brand-icons.ts";
import { icons } from "../../components/icons.ts";
import {
  canonicalLobsterLook,
  lobsterLookStyle,
  renderLobsterSvg,
} from "../../components/lobster-pet-look.ts";
import { LOBSTER_PET_PALETTES } from "../../components/lobster-pet-palettes.ts";
import { currentThemeBranding } from "../../components/neutral-mark.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import "../../components/tooltip.ts";
import { renderThemeBrandIcon } from "../../components/theme-brand-icon.ts";
import { t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatDateMs, formatDateTimeMs, formatRelativeTimestamp } from "../../lib/format.ts";
import "../../styles/about.css";
import { COMMUNITY_DISCORD_URL } from "../../lib/product-links.ts";

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

// Docs-first where a docs page exists; GitHub/Discord match the native
// macOS/iOS About screens (AboutSettings.swift, SettingsProTabSections.swift).
const ABOUT_LINKS: ReadonlyArray<{ href: string; icon: TemplateResult; labelKey: string }> = [
  { href: "https://openclaw.ai", icon: icons.globe, labelKey: "aboutPage.linkWebsite" },
  { href: "https://docs.openclaw.ai", icon: icons.book, labelKey: "aboutPage.linkDocs" },
  {
    href: "https://github.com/openclaw/openclaw",
    icon: brandIcons.github,
    labelKey: "aboutPage.linkGitHub",
  },
  {
    href: COMMUNITY_DISCORD_URL,
    icon: brandIcons.discord,
    labelKey: "aboutPage.linkDiscord",
  },
  {
    href: "https://x.com/openclaw",
    icon: brandIcons.x,
    labelKey: "aboutPage.linkX",
  },
  {
    href: "https://docs.openclaw.ai/releases",
    icon: icons.scrollText,
    labelKey: "aboutPage.linkChangelog",
  },
];

function renderUnavailable() {
  return html`<span class="muted">${t("aboutPage.unavailable")}</span>`;
}

// Always-relative commit age; the exact localized timestamp lives on hover
// (title) so the row stays compact for any artifact age.
function renderCommitAge(commitAt: string | null) {
  if (!commitAt) {
    return nothing;
  }
  const timestamp = Date.parse(commitAt);
  if (!Number.isFinite(timestamp)) {
    return nothing;
  }
  const exact = formatDateTimeMs(timestamp, { dateStyle: "medium", timeStyle: "short" });
  return html`
    <time class="about-commit__age" dir="auto" datetime=${commitAt} title=${exact}
      >${formatRelativeTimestamp(timestamp, { fallback: "" })}</time
    >
  `;
}

function renderCommit(props: AboutProps) {
  const commit = props.buildInfo.commit;
  if (!commit) {
    return renderUnavailable();
  }
  const label = t(
    {
      idle: "aboutPage.copyCommit",
      copying: "aboutPage.copyingCommit",
      copied: "aboutPage.copiedCommit",
      error: "aboutPage.copyCommitFailed",
    }[props.copyState],
  );
  return html`
    <span class="about-commit">
      <code dir="ltr" title=${commit}>${commit.slice(0, SHORT_COMMIT_LENGTH)}</code>
      ${renderCommitAge(props.buildInfo.commitAt)}
      <openclaw-tooltip .content=${label}>
        <button
          type="button"
          class="about-commit__copy"
          aria-label=${label}
          aria-busy=${props.copyState === "copying" ? "true" : nothing}
          ?disabled=${props.copyState === "copying"}
          @click=${props.onCopyCommit}
        >
          <span aria-hidden="true">${props.copyState === "copied" ? icons.check : icons.copy}</span>
        </button>
      </openclaw-tooltip>
      <span class="sr-only" role="status" aria-live="polite"
        >${props.copyState === "copied" || props.copyState === "error" ? label : ""}</span
      >
    </span>
  `;
}

// The same canonical crimson Clawd as the chat welcome hero, rendered big.
// The poke button replays the claw wave; ambient motion lives in about.css.
function renderHero(props: AboutProps) {
  const palette =
    LOBSTER_PET_PALETTES.find((entry) => entry.id === "crimson") ??
    expectDefined(LOBSTER_PET_PALETTES[0], "about lobster palette");
  const look = canonicalLobsterLook(palette);
  return html`
    <section class="about-hero">
      ${
        currentThemeBranding().brandIcon !== "claw"
          ? html`<span class="about-hero__mark--neutral" aria-hidden="true"
              >${renderThemeBrandIcon()}</span
            >`
          : html`<button
              type="button"
              class="about-hero__clawd ${props.clawdWaving ? "about-hero__clawd--wave" : ""}"
              style=${lobsterLookStyle(look)}
              aria-label=${t("aboutPage.waveHello")}
              @click=${props.onPokeClawd}
            >
              ${renderLobsterSvg(look)}
            </button>`
      }
      <h2 class="about-hero__name">${currentThemeBranding().brandName}</h2>
      <p class="about-hero__tagline">${t("aboutPage.tagline")}</p>
      ${
        props.buildInfo.version
          ? html`<code class="about-hero__version" dir="ltr">v${props.buildInfo.version}</code>`
          : nothing
      }
      <nav class="about-hero__links" aria-label=${t("aboutPage.linksLabel")}>
        ${(currentThemeBranding().communityLinks ? ABOUT_LINKS : []).map(
          (link) => html`
            <a
              class="about-hero__link"
              href=${link.href}
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
            >
              <span class="about-hero__link-icon" aria-hidden="true">${link.icon}</span>
              <span>${t(link.labelKey)}</span>
            </a>
          `,
        )}
      </nav>
    </section>
  `;
}

export function renderAbout(props: AboutProps) {
  const buildDate = formatDateMs(
    Date.parse(props.buildInfo.builtAt ?? ""),
    { dateStyle: "medium", timeZone: "UTC" },
    "",
  );
  const buildFacts = html`
    <dl class="settings-kv about-build-grid" aria-label=${t("aboutPage.artifactDetails")}>
      <dt>${t("aboutPage.version")}</dt>
      <dd>
        ${
          props.buildInfo.version
            ? html`<code dir="ltr" title=${props.buildInfo.version}
                >${props.buildInfo.version}</code
              >`
            : renderUnavailable()
        }
      </dd>
      <dt>${t("aboutPage.commit")}</dt>
      <dd>${renderCommit(props)}</dd>
      ${
        props.buildInfo.branch
          ? html`
              <dt>${t("aboutPage.branch")}</dt>
              <dd>
                <code dir="ltr" title=${props.buildInfo.branch}
                  >${props.buildInfo.branch}${props.buildInfo.dirty === true ? "*" : ""}</code
                >
              </dd>
            `
          : nothing
      }
      <dt>${t("aboutPage.built")}</dt>
      <dd>
        ${
          buildDate && props.buildInfo.builtAt
            ? html`<time
                dir="auto"
                datetime=${props.buildInfo.builtAt}
                title=${props.buildInfo.builtAt}
                >${buildDate}</time
              >`
            : renderUnavailable()
        }
      </dd>
    </dl>
  `;
  return renderSettingsPage([
    renderHero(props),
    renderSettingsSection(
      { title: t("aboutPage.artifactTitle"), description: t("aboutPage.artifactSubtitle") },
      buildFacts,
    ),
    renderSettingsSection(
      {},
      renderSettingsRow({
        title: t("aboutPage.gatewayVersion"),
        description: t("aboutPage.gatewayVersionHint"),
        control: props.gatewayVersion
          ? renderSettingsValue(
              html`<code dir="ltr" title=${props.gatewayVersion}>${props.gatewayVersion}</code>`,
              { mono: true },
            )
          : renderSettingsValue(t("aboutPage.unavailable")),
      }),
    ),
    html`<p class="about-footer">${t("aboutPage.license")}</p>`,
  ]);
}
