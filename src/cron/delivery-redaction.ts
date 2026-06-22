import { redactToolPayloadText } from "../logging/redact.js";

const CRON_DEVICE_AUTH_REDACTION = "[redacted device authorization output]";
const DEVICE_AUTH_URL_RE =
  /\bhttps?:\/\/[^\s<>"']*(?:microsoft\.com\/devicelogin|aka\.ms\/devicelogin|\/oauth2?\/device|\/device(?:code|login)?\b|device[-_]?code|device[-_]?login)[^\s<>"']*/iu;
const DEVICE_AUTH_CODE_LINE_RE =
  /\b(?:user[-_\s]?code|device[-_\s]?code|verification[-_\s]?(?:uri|url)|enter\s+(?:the\s+)?code)\b.*\b[A-Z0-9]{4,12}(?:-[A-Z0-9]{2,12}){0,4}\b/iu;

function redactActionRequiredLine(line: string): string {
  if (!line.trim()) {
    return line;
  }
  if (DEVICE_AUTH_URL_RE.test(line) || DEVICE_AUTH_CODE_LINE_RE.test(line)) {
    return CRON_DEVICE_AUTH_REDACTION;
  }
  return line;
}

function redactActionRequiredLines(text: string): string {
  return text
    .split(/(\r\n|\r|\n)/u)
    .map((part) => (/^(?:\r\n|\r|\n)$/u.test(part) ? part : redactActionRequiredLine(part)))
    .join("");
}

/** Redacts command output before it leaves cron's non-interactive delivery boundary. */
export function redactCronDeliveryText(text: string): string {
  const secretRedacted = redactToolPayloadText(text);
  return redactActionRequiredLines(secretRedacted);
}
