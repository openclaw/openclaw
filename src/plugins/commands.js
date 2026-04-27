/**
 * Plugin Command Registry
 *
 * Manages commands registered by plugins that bypass the LLM agent.
 * These commands are processed before built-in commands and before agent invocation.
 */
import { resolveConversationBindingContext } from "../channels/conversation-binding-context.js";
import { logVerbose } from "../globals.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { clearPluginCommands, clearPluginCommandsForPlugin, getPluginCommandSpecs, listPluginInvocationKeys, listProviderPluginCommandSpecs, registerPluginCommand, validateCommandName, validatePluginCommandDefinition, } from "./command-registration.js";
import { pluginCommands, setPluginCommandRegistryLocked, } from "./command-registry-state.js";
import { detachPluginConversationBinding, getCurrentPluginConversationBinding, requestPluginConversationBinding, } from "./conversation-binding.js";
import { getActivePluginChannelRegistry } from "./runtime.js";
// Maximum allowed length for command arguments (defense in depth)
const MAX_ARGS_LENGTH = 4096;
export { clearPluginCommands, clearPluginCommandsForPlugin, getPluginCommandSpecs, listProviderPluginCommandSpecs, registerPluginCommand, validateCommandName, validatePluginCommandDefinition, };
/**
 * Check if a command body matches a registered plugin command.
 * Returns the command definition and parsed args if matched.
 *
 * Note: If a command has `acceptsArgs: false` and the user provides arguments,
 * the command will not match. This allows the message to fall through to
 * built-in handlers or the agent. Document this behavior to plugin authors.
 */
export function matchPluginCommand(commandBody) {
    const trimmed = commandBody.trim();
    if (!trimmed.startsWith("/")) {
        return null;
    }
    // Extract command name and args
    const spaceIndex = trimmed.indexOf(" ");
    const commandName = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
    const args = spaceIndex === -1 ? undefined : trimmed.slice(spaceIndex + 1).trim();
    const key = normalizeLowercaseStringOrEmpty(commandName);
    const alternateKeys = [key];
    if (key.includes("_")) {
        alternateKeys.push(key.replace(/_/g, "-"));
    }
    if (key.includes("-")) {
        alternateKeys.push(key.replace(/-/g, "_"));
    }
    const command = alternateKeys
        .map((candidateKey) => pluginCommands.get(candidateKey) ??
        Array.from(pluginCommands.values()).find((candidate) => listPluginInvocationNames(candidate).includes(candidateKey)))
        .find(Boolean) ?? null;
    if (!command) {
        return null;
    }
    // If command doesn't accept args but args were provided, don't match
    if (args && !command.acceptsArgs) {
        return null;
    }
    return { command, args: args || undefined };
}
/**
 * Sanitize command arguments to prevent injection attacks.
 * Removes control characters and enforces length limits.
 */
function sanitizeArgs(args) {
    if (!args) {
        return undefined;
    }
    // Enforce length limit
    if (args.length > MAX_ARGS_LENGTH) {
        return args.slice(0, MAX_ARGS_LENGTH);
    }
    // Remove control characters (except newlines and tabs which may be intentional)
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
function resolveBindingConversationFromCommand(params) {
    const channelPlugin = getActivePluginChannelRegistry()?.channels.find((entry) => entry.plugin.id === params.channel)?.plugin;
    if (!channelPlugin?.bindings?.resolveCommandConversation) {
        return null;
    }
    return resolveConversationBindingContext({
        cfg: params.config ?? {},
        channel: params.channel,
        accountId: params.accountId,
        threadId: params.messageThreadId,
        threadParentId: params.threadParentId,
        senderId: params.senderId,
        originatingTo: params.from,
        commandTo: params.to,
        fallbackTo: params.to ?? params.from,
    });
}
/**
 * Execute a plugin command handler.
 *
 * Note: Plugin authors should still validate and sanitize ctx.args for their
 * specific use case. This function provides basic defense-in-depth sanitization.
 */
export async function executePluginCommand(params) {
    const { command, args, senderId, channel, isAuthorizedSender, commandBody, config } = params;
    // Check authorization
    const requireAuth = command.requireAuth !== false; // Default to true
    if (requireAuth && !isAuthorizedSender) {
        logVerbose(`Plugin command /${command.name} blocked: unauthorized sender ${senderId || "<unknown>"}`);
        return { text: "⚠️ This command requires authorization." };
    }
    // Sanitize args before passing to handler
    const sanitizedArgs = sanitizeArgs(args);
    const bindingConversation = resolveBindingConversationFromCommand({
        config,
        channel,
        senderId,
        from: params.from,
        to: params.to,
        accountId: params.accountId,
        messageThreadId: params.messageThreadId,
        threadParentId: params.threadParentId,
    });
    const effectiveAccountId = bindingConversation?.accountId ?? params.accountId;
    const ctx = {
        senderId,
        channel,
        channelId: params.channelId,
        isAuthorizedSender,
        gatewayClientScopes: params.gatewayClientScopes,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        args: sanitizedArgs,
        commandBody,
        config,
        from: params.from,
        to: params.to,
        accountId: effectiveAccountId,
        messageThreadId: params.messageThreadId,
        threadParentId: params.threadParentId,
        requestConversationBinding: async (bindingParams) => {
            if (!command.pluginRoot || !bindingConversation) {
                return {
                    status: "error",
                    message: "This command cannot bind the current conversation.",
                };
            }
            return requestPluginConversationBinding({
                pluginId: command.pluginId,
                pluginName: command.pluginName,
                pluginRoot: command.pluginRoot,
                requestedBySenderId: senderId,
                conversation: bindingConversation,
                binding: bindingParams,
            });
        },
        detachConversationBinding: async () => {
            if (!command.pluginRoot || !bindingConversation) {
                return { removed: false };
            }
            return detachPluginConversationBinding({
                pluginRoot: command.pluginRoot,
                conversation: bindingConversation,
            });
        },
        getCurrentConversationBinding: async () => {
            if (!command.pluginRoot || !bindingConversation) {
                return null;
            }
            return getCurrentPluginConversationBinding({
                pluginRoot: command.pluginRoot,
                conversation: bindingConversation,
            });
        },
    };
    // Lock registry during execution to prevent concurrent modifications
    setPluginCommandRegistryLocked(true);
    try {
        const result = await command.handler(ctx);
        logVerbose(`Plugin command /${command.name} executed successfully for ${senderId || "unknown"}`);
        return result;
    }
    catch (err) {
        const error = err;
        logVerbose(`Plugin command /${command.name} error: ${error.message}`);
        // Don't leak internal error details - return a safe generic message
        return { text: "⚠️ Command failed. Please try again later." };
    }
    finally {
        setPluginCommandRegistryLocked(false);
    }
}
/**
 * List all registered plugin commands.
 * Used for /help and /commands output.
 */
export function listPluginCommands() {
    return Array.from(pluginCommands.values()).map((cmd) => ({
        name: cmd.name,
        description: cmd.description,
        pluginId: cmd.pluginId,
        acceptsArgs: cmd.acceptsArgs ?? false,
    }));
}
function listPluginInvocationNames(command) {
    return listPluginInvocationKeys(command);
}
export const __testing = {
    resolveBindingConversationFromCommand,
};
