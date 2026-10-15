import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatCliCommand } from "./command-format.js";

const DEFAULT_GATEWAY_PORT_EXAMPLE = 18789;

function formatInlineCliCommand(command: string): string {
  return `\`${formatCliCommand(command)}\``;
}

export function formatPortRangeHint(): string {
  return `Use a port number from 1 to 65535, for example ${DEFAULT_GATEWAY_PORT_EXAMPLE}.`;
}

export function formatInvalidPortOption(option: string): string {
  return `Invalid ${option}. ${formatPortRangeHint()}`;
}

export function formatInvalidConfigPort(path: string): string {
  return `Invalid ${path} in config. Set ${path} to a number from 1 to 65535, or pass --port ${DEFAULT_GATEWAY_PORT_EXAMPLE}.`;
}

export function formatUnknownChannelMessage(params: { channel: string }): string {
  return `Unknown channel "${params.channel}". Run ${formatInlineCliCommand(
    "openclaw channels list --all",
  )} to see configured and installable channels.`;
}

export function formatUnsupportedChannelActionMessage(params: {
  channel: string;
  action: string;
  inspectCommand?: string;
}): string {
  const inspectCommand =
    params.inspectCommand ?? `openclaw channels capabilities --channel ${params.channel}`;
  return `Channel "${params.channel}" does not support ${params.action}. Run ${formatInlineCliCommand(
    inspectCommand,
  )} to inspect supported actions.`;
}

export function formatStrictJsonParseFailure(params: { value: string; cause: unknown }): string {
  const rawCause = params.cause instanceof Error ? params.cause.message : String(params.cause);
  const cause = rawCause.trim().replace(/[.。]+$/u, "");
  const preview =
    params.value.length > 48 ? `${truncateUtf16Safe(params.value, 45).trimEnd()}...` : params.value;
  return [
    `Could not parse ${JSON.stringify(preview)} as JSON for --strict-json.`,
    `${cause}.`,
    `Use valid JSON. For structured changes, use a JSON5 config patch object file with ${formatInlineCliCommand(
      "openclaw config patch --file <path> --dry-run",
    )}.`,
    "For plain strings, omit --strict-json.",
  ].join(" ");
}

export function formatGatewayCommandFailure(params: { action: string; error: unknown }): string {
  const raw = params.error instanceof Error ? params.error.message : String(params.error);
  const message = raw
    .replace(/\s*Run [`"]?openclaw doctor[`"]? for diagnostics\.?/gi, "")
    .replace(/\s+Gateway target:\s+.*$/isu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.。]+$/u, "");
  const detail = message ? `: ${message}` : "";
  return `Could not ${params.action} because the Gateway did not respond${detail}. Run ${formatInlineCliCommand(
    "openclaw gateway status --deep",
  )} to inspect the active Gateway.`;
}

export function formatLookupMiss(params: {
  noun: string;
  value: string;
  listCommand: string;
  valueLabel?: string;
}): string {
  const valueLabel = params.valueLabel ?? params.noun.toLowerCase();
  return `${params.noun} not found: ${params.value}. Run ${formatInlineCliCommand(
    params.listCommand,
  )} to see recent ${valueLabel}s.`;
}

export function formatMissingPluginMessage(params: {
  id: string;
  listCommand?: string;
  includeSearch?: boolean;
}): string {
  const listCommand = params.listCommand ?? "openclaw plugins list";
  const searchHint = params.includeSearch
    ? `, or ${formatInlineCliCommand("openclaw plugins search " + params.id)} to look for installable plugins`
    : "";
  return `Plugin not found: ${params.id}. Run ${formatInlineCliCommand(
    listCommand,
  )} to see installed plugins${searchHint}.`;
}
