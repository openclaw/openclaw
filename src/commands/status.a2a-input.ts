import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import type { A2AStatusSummary, StatusContributorSummary, StatusSummary } from "./status.types.js";

export type NormalizedStatusA2AInput = {
  source: "contributor" | "summary.a2a";
  state: "ok" | "warn" | "error" | "info";
  summary: string;
  details: string[];
};

function listNormalizedContributorDetails(details: StatusContributorSummary["details"]): string[] {
  return Array.isArray(details)
    ? details
        .filter((detail): detail is string => typeof detail === "string" && detail.trim().length > 0)
        .map((detail) => detail.trim())
    : [];
}

function findA2AContributor(
  contributors: StatusContributorSummary[] | undefined,
): StatusContributorSummary | undefined {
  const list = Array.isArray(contributors) ? contributors : [];
  return list.find((contributor) => {
    const id = normalizeLowercaseStringOrEmpty(contributor.id);
    const label = normalizeLowercaseStringOrEmpty(contributor.label);
    return id === "a2a" || label === "a2a";
  });
}

export function normalizeStatusA2AContributorInput(
  contributor: StatusContributorSummary | null | undefined,
): NormalizedStatusA2AInput | undefined {
  if (!contributor) {
    return undefined;
  }
  const id = normalizeLowercaseStringOrEmpty(contributor.id);
  const label = normalizeLowercaseStringOrEmpty(contributor.label);
  if (id !== "a2a" && label !== "a2a") {
    return undefined;
  }
  const summary = contributor.summary.trim();
  if (!summary) {
    return undefined;
  }
  return {
    source: "contributor",
    state: contributor.state,
    summary,
    details: listNormalizedContributorDetails(contributor.details),
  };
}

export function buildStatusA2ASummaryFallbackInput(
  a2a: A2AStatusSummary | null | undefined,
): NormalizedStatusA2AInput | undefined {
  if (!a2a) {
    return undefined;
  }
  const state: NormalizedStatusA2AInput["state"] =
    a2a.state === "ok"
      ? "ok"
      : a2a.state === "delayed" || a2a.state === "waiting_external"
        ? "warn"
        : a2a.state === "failed" || a2a.state === "config_error"
          ? "error"
          : "info";
  const summaryLabelByState: Record<A2AStatusSummary["state"], string> = {
    ok: "ok",
    delayed: "delayed",
    waiting_external: "waiting external",
    failed: "failed",
    config_error: "config error",
  };
  const details = [`broker ${a2a.broker.adapterEnabled ? "on" : "off"}`];
  if (a2a.tasks.active > 0) {
    details.push(`${a2a.tasks.active} active`);
  } else {
    details.push("no active");
  }
  if (a2a.tasks.waitingExternal > 0) {
    details.push(`${a2a.tasks.waitingExternal} waiting external`);
  }
  if (a2a.tasks.delayed > 0) {
    details.push(`${a2a.tasks.delayed} delayed`);
  }
  if (a2a.tasks.failed > 0) {
    details.push(`${a2a.tasks.failed} failed`);
  }
  if (a2a.state === "config_error") {
    const configHints: string[] = [];
    if (!a2a.broker.baseUrlPresent) {
      configHints.push("baseUrl missing");
    }
    if (!a2a.broker.methodScopesOk) {
      configHints.push("scope map missing");
    }
    if (configHints.length > 0) {
      details.push(configHints.join(", "));
    }
  } else if (a2a.tasks.latestFailed) {
    const detail =
      a2a.tasks.latestFailed.errorMessage ??
      a2a.tasks.latestFailed.errorCode ??
      a2a.tasks.latestFailed.summary ??
      a2a.tasks.latestFailed.taskId;
    details.push(`latest ${detail}`);
  }
  return {
    source: "summary.a2a",
    state,
    summary: summaryLabelByState[a2a.state],
    details,
  };
}

export function resolvePreferredStatusA2AInput(params: {
  summary: Pick<StatusSummary, "contributors" | "a2a">;
}): NormalizedStatusA2AInput | undefined {
  const contributor = findA2AContributor(params.summary.contributors);
  return (
    normalizeStatusA2AContributorInput(contributor) ??
    buildStatusA2ASummaryFallbackInput(params.summary.a2a)
  );
}
