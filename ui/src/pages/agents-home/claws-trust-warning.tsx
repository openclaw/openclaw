import { t } from "../../i18n/index.ts";
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
  const wrappedDetails = content.at(-2) === "Details:";
  const details = wrappedDetails ? content.at(-1) : content.at(-1)?.match(/^Details: (.+)$/u)?.[1];
  const overview = content.slice(3, wrappedDetails ? -2 : -1).join(" ");
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
  const title =
    audit?.outcome.toLowerCase() === "review"
      ? t("clawsTrustWarning.reviewRequired")
      : audit
        ? `${t("clawsTrustWarning.title")}: ${audit.outcome}`
        : "";
  return (
    <div class="callout warn claws-trust-warning" role="alert">
      {audit ? (
        <>
          <strong class="claws-trust-warning__title">{title}</strong>
          <p>{audit.overview}</p>
          {detailsUrl ? (
            <a href={detailsUrl} target="_blank" rel="noopener noreferrer">
              {t("clawsTrustWarning.details")}
            </a>
          ) : undefined}
        </>
      ) : (
        <span class="claws-trust-warning__plain">{warning}</span>
      )}
    </div>
  );
}
