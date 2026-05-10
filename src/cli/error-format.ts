import { formatCliCommand } from "./command-format.js";

const DEFAULT_GATEWAY_PORT_EXAMPLE = 18789;

export function formatPortRangeHint(example = DEFAULT_GATEWAY_PORT_EXAMPLE): string {
  return `Use a port number from 1 to 65535, for example ${example}.`;
}

export function formatInvalidPortOption(
  option: string,
  example = DEFAULT_GATEWAY_PORT_EXAMPLE,
): string {
  return `Invalid ${option}. ${formatPortRangeHint(example)}`;
}

export function formatInvalidConfigPort(
  path: string,
  example = DEFAULT_GATEWAY_PORT_EXAMPLE,
): string {
  return `Invalid ${path} in config. Set ${path} to a number from 1 to 65535, or pass --port ${example}.`;
}

export function formatUnknownChannelMessage(params: {
  channel: string;
  listCommand?: string;
  purpose?: string;
}): string {
  const purpose = params.purpose ? ` for ${params.purpose}` : "";
  const listCommand = params.listCommand ?? "openclaw channels list --all";
  return `Unknown channel "${params.channel}"${purpose}. Run ${formatCliCommand(
    listCommand,
  )} to see configured and installable channels.`;
}

export function formatUnsupportedChannelActionMessage(params: {
  channel: string;
  action: string;
  inspectCommand?: string;
}): string {
  const inspectCommand =
    params.inspectCommand ?? `openclaw channels capabilities --channel ${params.channel}`;
  return `Channel "${params.channel}" does not support ${params.action}. Run ${formatCliCommand(
    inspectCommand,
  )} to inspect supported actions.`;
}

export function formatLookupMiss(params: {
  noun: string;
  value: string;
  listCommand: string;
  valueLabel?: string;
}): string {
  const valueLabel = params.valueLabel ?? params.noun.toLowerCase();
  return `${params.noun} not found: ${params.value}. Run ${formatCliCommand(
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
    ? `, or ${formatCliCommand("openclaw plugins search " + params.id)} to look for installable plugins`
    : "";
  return `Plugin not found: ${params.id}. Run ${formatCliCommand(
    listCommand,
  )} to see installed plugins${searchHint}.`;
}
