import { ErrorCodes, isGatewayProtocolResponseError } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import { parseJson5Text } from "../json5-runtime.ts";
import type { RuntimeConfigState } from "./config-state-model.ts";

function formatConfigMutationError(error: unknown, submittedRaw: string | null): string {
  const formatted = formatUiError(error);
  let message = error instanceof GatewayRequestError ? `${error.name}: ${formatted}` : formatted;
  if (!submittedRaw || !(error instanceof GatewayRequestError) || !isRecord(error.details)) {
    return message;
  }
  const issues = error.details.issues;
  if (!Array.isArray(issues)) {
    return message;
  }
  const summaryPrefix = `${error.name}: invalid config: `;
  if (!message.startsWith(summaryPrefix)) {
    return message;
  }
  let submittedForm: unknown;
  try {
    submittedForm = parseJson5Text(submittedRaw);
  } catch {
    return message;
  }
  if (!isRecord(submittedForm)) {
    return message;
  }
  let offset = summaryPrefix.length;
  for (const issue of issues) {
    if (
      !isRecord(issue) ||
      typeof issue.path !== "string" ||
      typeof issue.message !== "string" ||
      !message.startsWith(`${issue.path}: ${issue.message}`, offset)
    ) {
      break;
    }
    const displayPath = formatConfigIssuePathFromDraft(issue.path, submittedForm);
    if (displayPath !== issue.path) {
      message = `${message.slice(0, offset)}${displayPath}${message.slice(offset + issue.path.length)}`;
    }
    offset += displayPath.length + 2 + issue.message.length;
    if (!message.startsWith("; ", offset)) {
      break;
    }
    offset += 2;
  }
  return message;
}

function formatConfigIssuePathFromDraft(path: string, draft: unknown): string {
  const segments = path.split(".");

  const visit = (value: unknown, offset: number): string[] => {
    if (offset === segments.length) {
      return [""];
    }
    const segment = segments[offset];
    if (segment === undefined) {
      return [];
    }
    if (Array.isArray(value)) {
      const index = Number(segment);
      if (!/^\d+$/u.test(segment) || !Number.isSafeInteger(index) || !Object.hasOwn(value, index)) {
        return [segments.slice(offset).join(".")];
      }
      return visit(value[index], offset + 1).map((tail) =>
        tail ? `#${index + 1}.${tail}` : `#${index + 1}`,
      );
    }
    if (!isRecord(value)) {
      return [segments.slice(offset).join(".")];
    }

    const matches = Object.keys(value).flatMap((key) => {
      const keySegments = key.split(".");
      if (
        keySegments.length > segments.length - offset ||
        !keySegments.every((keySegment, index) => keySegment === segments[offset + index])
      ) {
        return [];
      }
      return visit(value[key], offset + keySegments.length).map((tail) =>
        tail ? `${key}.${tail}` : key,
      );
    });
    return matches.length > 0 ? matches : [segments.slice(offset).join(".")];
  };

  // Flattened Gateway paths cannot distinguish overlapping dotted object keys;
  // keep the machine path unless the actual draft proves one display spelling.
  const displayPaths = new Set(visit(draft, 0));
  return displayPaths.size === 1 ? (displayPaths.values().next().value ?? path) : path;
}

// Publication and read-recovery outcomes outrank nested pre-write conflict text.
export function configMutationFailure(
  state: RuntimeConfigState,
  error: unknown,
  submittedRaw?: string | null,
) {
  let message =
    submittedRaw !== undefined
      ? formatConfigMutationError(error, submittedRaw)
      : formatUiError(error);
  const details =
    error instanceof GatewayRequestError && isRecord(error.details) ? error.details : null;
  const hasRecoveryOutcome =
    details && (details.publication === "partial" || details.publication === "complete");
  if (hasRecoveryOutcome) {
    if (details.rollbackStatus !== "restored") {
      if (typeof details.configPath === "string") {
        message = t(
          details.rollbackStatus === "not-restored"
            ? "configView.recoveryNotRestored"
            : "configView.recoveryUnknown",
          { path: details.configPath },
        );
        if (typeof details.recoveryBackupPath === "string") {
          message += "\n" + t("configView.recoveryBackup", { path: details.recoveryBackupPath });
        }
      }
      state.configRecoveryError = message;
    }
    return { status: "error" as const, message };
  }
  if (message.includes("config changed since last load")) {
    return { status: "conflict" as const, message };
  }
  // Only a correlated validation response proves this attempt never published.
  // Receipt retirement also covers permission failures and restored writes.
  if (
    error instanceof GatewayRequestError &&
    isGatewayProtocolResponseError(error) &&
    error.gatewayCode === ErrorCodes.INVALID_REQUEST &&
    details?.publication === undefined &&
    details?.persistedConfig === undefined &&
    Array.isArray(details?.issues) &&
    details.issues.length > 0 &&
    details.issues.every(
      (issue) =>
        isRecord(issue) && typeof issue.path === "string" && typeof issue.message === "string",
    )
  ) {
    return {
      status: "rejected" as const,
      message: message.replace(/^GatewayRequestError: /u, ""),
    };
  }
  return { status: "error" as const, message };
}

export function isDefinitiveConfigMutationRejection(err: unknown): boolean {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  const details = isRecord(err.details) ? err.details : null;
  if (details && (details.publication === "partial" || details.publication === "complete")) {
    return details.rollbackStatus === "restored";
  }
  return err.gatewayCode === ErrorCodes.INVALID_REQUEST || err.gatewayCode === ErrorCodes.FORBIDDEN;
}
