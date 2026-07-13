import { html, nothing } from "lit";
import type { ControlUiBuildInfo } from "../../build-info.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import "../../components/tooltip.ts";
import { i18n, t } from "../../i18n/index.ts";
import "../../styles/about.css";

export type AboutCommitCopyState = "idle" | "copying" | "copied" | "error";

export type AboutProps = {
  buildInfo: ControlUiBuildInfo;
  gatewayVersion: string | null;
  copyState: AboutCommitCopyState;
  onCopyCommit: () => void;
};

const SHORT_COMMIT_LENGTH = 12;

export function formatControlUiBuildDate(
  value: string | null,
  locales?: Intl.LocalesArgument,
): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(locales, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

function copyButtonLabel(state: AboutCommitCopyState): string {
  if (state === "copying") {
    return t("aboutPage.copyingCommit");
  }
  if (state === "copied") {
    return t("aboutPage.copiedCommit");
  }
  if (state === "error") {
    return t("aboutPage.copyCommitFailed");
  }
  return t("aboutPage.copyCommit");
}

function copyStatus(state: AboutCommitCopyState): string {
  return state === "copied"
    ? t("aboutPage.copiedCommit")
    : state === "error"
      ? t("aboutPage.copyCommitFailed")
      : "";
}

function renderUnavailable() {
  return html`<span class="muted">${t("aboutPage.unavailable")}</span>`;
}

function renderCommit(props: AboutProps) {
  const commit = props.buildInfo.commit;
  if (!commit) {
    return renderUnavailable();
  }
  const label = copyButtonLabel(props.copyState);
  return html`
    <span class="about-commit">
      <code dir="ltr" title=${commit}>${commit.slice(0, SHORT_COMMIT_LENGTH)}</code>
      <openclaw-tooltip .content=${label}>
        <button
          type="button"
          class="btn btn--icon"
          aria-label=${label}
          aria-busy=${props.copyState === "copying" ? "true" : nothing}
          ?disabled=${props.copyState === "copying"}
          @click=${props.onCopyCommit}
        >
          <span aria-hidden="true">${props.copyState === "copied" ? icons.check : icons.copy}</span>
        </button>
      </openclaw-tooltip>
      <span class="about-sr-only" role="status" aria-live="polite"
        >${copyStatus(props.copyState)}</span
      >
    </span>
  `;
}

export function renderAbout(props: AboutProps) {
  const buildDate = formatControlUiBuildDate(props.buildInfo.builtAt, i18n.getLocale());
  const buildFacts = html`
    <dl class="settings-kv" role="group" aria-label=${t("aboutPage.artifactDetails")}>
      <dt>${t("aboutPage.version")}</dt>
      <dd>
        ${props.buildInfo.version
          ? html`<code dir="ltr" title=${props.buildInfo.version}>${props.buildInfo.version}</code>`
          : renderUnavailable()}
      </dd>
      <dt>${t("aboutPage.commit")}</dt>
      <dd>${renderCommit(props)}</dd>
      ${props.buildInfo.branch
        ? html`
            <dt>${t("aboutPage.branch")}</dt>
            <dd>
              <code dir="ltr" title=${props.buildInfo.branch}
                >${props.buildInfo.branch}${props.buildInfo.dirty === true ? "*" : ""}</code
              >
            </dd>
          `
        : nothing}
      <dt>${t("aboutPage.built")}</dt>
      <dd>
        ${buildDate && props.buildInfo.builtAt
          ? html`<time
              dir="auto"
              datetime=${props.buildInfo.builtAt}
              title=${props.buildInfo.builtAt}
              >${buildDate}</time
            >`
          : renderUnavailable()}
      </dd>
    </dl>
  `;
  return renderSettingsPage([
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
  ]);
}
