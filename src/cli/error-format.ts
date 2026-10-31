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
