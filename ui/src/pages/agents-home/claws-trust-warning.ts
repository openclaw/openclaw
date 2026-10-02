import { html } from "lit";
import "../../styles/claws-trust-warning.css";

type ClawHubAudit = {
  release: string;
  outcome: string;
  overview: string;
  details: string;
};

function parseClawHubAudit(warning: string): ClawHubAudit | null {
  const lines = warning.trim().split(/\r?\n/u);
  if (
    !/^╭─ ClawHub Security Audit ─+╮$/u.test(lines[0] ?? "") ||
    !/^╰─+╯$/u.test(lines.at(-1) ?? "")
  ) {
    return null;
  }
  const body = lines.slice(1, -1).map((line) => /^│ (.*) │$/u.exec(line)?.[1]?.trim() ?? null);
  if (body.some((line) => line === null)) {
    return null;
  }
  const content = body.filter((line): line is string => Boolean(line));
  const release = content[0];
  const outcome = content[1]?.match(/^Outcome: (.+)$/u)?.[1];
  const overviewHeading = content[2];
  const details = content.at(-1)?.match(/^Details: (.+)$/u)?.[1];
  const overview = content.slice(3, -1).join(" ");
  if (!release || !outcome || overviewHeading !== "Overview:" || !overview || !details) {
    return null;
  }
  return { release, outcome, overview, details };
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function renderClawTrustWarning(warning: string) {
  const audit = parseClawHubAudit(warning);
  const detailsUrl = audit ? httpUrl(audit.details) : null;
  return html`<div class="callout warn claws-trust-warning" role="alert">
    ${
      audit
        ? html`<strong class="claws-trust-warning__title">ClawHub Security Audit</strong>
            <div class="claws-trust-warning__release">${audit.release}</div>
            <div><strong>Outcome:</strong> ${audit.outcome}</div>
            <div><strong>Overview:</strong> ${audit.overview}</div>
            <div>
              <strong>Details:</strong>
              ${
                detailsUrl
                  ? html`<a href=${detailsUrl} target="_blank" rel="noopener noreferrer"
                      >${audit.details}</a
                    >`
                  : audit.details
              }
            </div>`
        : html`<span class="claws-trust-warning__plain">${warning}</span>`
    }
  </div>`;
}
