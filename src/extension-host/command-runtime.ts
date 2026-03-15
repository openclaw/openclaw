import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "../plugins/types.js";

export type RegisteredExtensionHostPluginCommand = OpenClawPluginCommandDefinition & {
  pluginId: string;
};

const extensionHostPluginCommands = new Map<string, RegisteredExtensionHostPluginCommand>();

let extensionHostCommandRegistryLocked = false;

const MAX_ARGS_LENGTH = 4096;

const RESERVED_COMMANDS = new Set([
  "help",
  "commands",
  "status",
  "whoami",
  "context",
  "btw",
  "stop",
  "restart",
  "reset",
  "new",
  "compact",
  "config",
  "debug",
  "allowlist",
  "activation",
  "skill",
  "subagents",
  "kill",
  "steer",
  "tell",
  "model",
  "models",
  "queue",
  "send",
  "bash",
  "exec",
  "think",
  "verbose",
  "reasoning",
  "elevated",
  "usage",
]);

export type CommandRegistrationResult = {
  ok: boolean;
  error?: string;
};

export function validateExtensionHostCommandName(name: string): string | null {
  const trimmed = name.trim().toLowerCase();

  if (!trimmed) {
    return "Command name cannot be empty";
  }

  if (!/^[a-z][a-z0-9_-]*$/.test(trimmed)) {
    return "Command name must start with a letter and contain only letters, numbers, hyphens, and underscores";
  }

  if (RESERVED_COMMANDS.has(trimmed)) {
    return `Command name "${trimmed}" is reserved by a built-in command`;
  }

  return null;
}

export function registerExtensionHostPluginCommand(
  pluginId: string,
  command: OpenClawPluginCommandDefinition,
): CommandRegistrationResult {
  if (extensionHostCommandRegistryLocked) {
    return { ok: false, error: "Cannot register commands while processing is in progress" };
  }

  if (typeof command.handler !== "function") {
    return { ok: false, error: "Command handler must be a function" };
  }

  if (typeof command.name !== "string") {
    return { ok: false, error: "Command name must be a string" };
  }

  if (typeof command.description !== "string") {
    return { ok: false, error: "Command description must be a string" };
  }

  const name = command.name.trim();
  const description = command.description.trim();
  if (!description) {
    return { ok: false, error: "Command description cannot be empty" };
  }

  const validationError = validateExtensionHostCommandName(name);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const key = `/${name.toLowerCase()}`;
  const existing = extensionHostPluginCommands.get(key);
  if (existing) {
    return {
      ok: false,
      error: `Command "${name}" already registered by plugin "${existing.pluginId}"`,
    };
  }

  extensionHostPluginCommands.set(key, { ...command, name, description, pluginId });
  logVerbose(`Registered plugin command: ${key} (plugin: ${pluginId})`);
  return { ok: true };
}

export function clearExtensionHostPluginCommands(): void {
  extensionHostPluginCommands.clear();
}

export function clearExtensionHostPluginCommandsForPlugin(pluginId: string): void {
  for (const [key, cmd] of extensionHostPluginCommands.entries()) {
    if (cmd.pluginId === pluginId) {
      extensionHostPluginCommands.delete(key);
    }
  }
}

export function matchExtensionHostPluginCommand(
  commandBody: string,
): { command: RegisteredExtensionHostPluginCommand; args?: string } | null {
  const trimmed = commandBody.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const spaceIndex = trimmed.indexOf(" ");
  const commandName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const args = spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim();

  const command = extensionHostPluginCommands.get(commandName.toLowerCase());
  if (!command) {
    return null;
  }

  if (args && !command.acceptsArgs) {
    return null;
  }

  return { command, args: args || undefined };
}

function sanitizeArgs(args: string | undefined): string | undefined {
  if (!args) {
    return undefined;
  }

  if (args.length > MAX_ARGS_LENGTH) {
    return args.slice(0, MAX_ARGS_LENGTH);
  }

  let sanitized = "";
  for (const char of args) {
    const code = char.charCodeAt(0);
    const isControl = (code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f;
    if (!isControl) {
      sanitized += char;
    }
  }
  return sanitized;
}

export async function executeExtensionHostPluginCommand(params: {
  command: RegisteredExtensionHostPluginCommand;
  args?: string;
  senderId?: string;
  channel: string;
  channelId?: PluginCommandContext["channelId"];
  isAuthorizedSender: boolean;
  commandBody: string;
  config: OpenClawConfig;
  from?: PluginCommandContext["from"];
  to?: PluginCommandContext["to"];
  accountId?: PluginCommandContext["accountId"];
  messageThreadId?: PluginCommandContext["messageThreadId"];
}): Promise<PluginCommandResult> {
  const { command, args, senderId, channel, isAuthorizedSender, commandBody, config } = params;

  const requireAuth = command.requireAuth !== false;
  if (requireAuth && !isAuthorizedSender) {
    logVerbose(
      `Plugin command /${command.name} blocked: unauthorized sender ${senderId || "<unknown>"}`,
    );
    return { text: "⚠️ This command requires authorization." };
  }

  const ctx: PluginCommandContext = {
    senderId,
    channel,
    channelId: params.channelId,
    isAuthorizedSender,
    args: sanitizeArgs(args),
    commandBody,
    config,
    from: params.from,
    to: params.to,
    accountId: params.accountId,
    messageThreadId: params.messageThreadId,
    requestConversationBinding: async () => ({
      status: "error" as const,
      message: "Conversation binding is unavailable for this command surface.",
    }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  };

  extensionHostCommandRegistryLocked = true;
  try {
    const result = await command.handler(ctx);
    logVerbose(
      `Plugin command /${command.name} executed successfully for ${senderId || "unknown"}`,
    );
    return result;
  } catch (err) {
    const error = err as Error;
    logVerbose(`Plugin command /${command.name} error: ${error.message}`);
    return { text: "⚠️ Command failed. Please try again later." };
  } finally {
    extensionHostCommandRegistryLocked = false;
  }
}

function resolveExtensionHostPluginNativeName(
  command: OpenClawPluginCommandDefinition,
  provider?: string,
): string {
  const providerName = provider?.trim().toLowerCase();
  const providerOverride = providerName ? command.nativeNames?.[providerName] : undefined;
  if (typeof providerOverride === "string" && providerOverride.trim()) {
    return providerOverride.trim();
  }
  const defaultOverride = command.nativeNames?.default;
  if (typeof defaultOverride === "string" && defaultOverride.trim()) {
    return defaultOverride.trim();
  }
  return command.name;
}

export function listExtensionHostPluginCommands(): Array<{
  name: string;
  description: string;
  pluginId: string;
}> {
  return Array.from(extensionHostPluginCommands.values()).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    pluginId: cmd.pluginId,
  }));
}

export function getExtensionHostPluginCommandSpecs(provider?: string): Array<{
  name: string;
  description: string;
  acceptsArgs: boolean;
}> {
  return Array.from(extensionHostPluginCommands.values()).map((cmd) => ({
    name: resolveExtensionHostPluginNativeName(cmd, provider),
    description: cmd.description,
    acceptsArgs: cmd.acceptsArgs ?? false,
  }));
}
