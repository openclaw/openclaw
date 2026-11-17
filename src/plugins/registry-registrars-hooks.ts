import path from "node:path";
import {
  normalizeStringEntries,
  uniqueValues,
} from "@openclaw/normalization-core/string-normalization";
import type { InternalHookHandler } from "../hooks/internal-hook-types.js";
import type { HookEntry } from "../hooks/types.js";
import {
  resolveConversationAccessAllowed,
  resolvePromptInjectionAllowed,
} from "./hook-policy-decisions.js";
import { PLUGIN_HOOK_METADATA } from "./hook-types.js";
import {
  resolveTypedHookTimeoutMs,
  type PluginRegistryState,
  type PluginTypedHookPolicy,
} from "./registry-state.js";
import type { PluginBlockedHookReason, PluginRecord } from "./registry-types.js";
import { normalizePluginToolMatcher } from "./tool-hook-matcher.js";
import {
  isPluginHookAgentTrigger,
  isPluginHookName,
  isPluginHookReplyDispatchKind,
  isPromptInjectionHookName,
} from "./types.js";
import type {
  OpenClawPluginApi,
  OpenClawPluginHookOptions,
  PluginHookHandlerMap,
  PluginHookName,
  PluginHookRegistrationOptions,
} from "./types.js";

function normalizeHookEligibility<T>(value: unknown, isEligible: (item: unknown) => item is T) {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = Array.from(value);
  if (entries.length === 0 || !entries.every(isEligible)) {
    return undefined;
  }
  return uniqueValues(entries);
}

/**
 * The implicit conversation-access refusal is the only one the operator did not
 * ask for: a non-bundled plugin registers a conversation hook, nobody ever set
 * `allowConversationAccess`, and the default deny silently disables the handler
 * while `api.on()` reports nothing back. That combination has shipped
 * multi-day silent degradation, so the message must carry the config path, the
 * remedy, and how to verify — and it is emitted at `error`, unlike the two
 * deliberate denials below.
 */
function formatImplicitConversationAccessBlockDiagnostic(params: {
  pluginId: string;
  hookName: PluginHookName;
  configPath: string;
}): string {
  return (
    `typed hook "${params.hookName}" from non-bundled plugin "${params.pluginId}" was NOT registered: ` +
    `conversation hooks need an explicit grant and ${params.configPath} is unset, so the plugin's ` +
    `handler is inactive even though api.on() reported no error. ` +
    `Fix: set "${params.configPath}": true; the default hybrid config reload applies it to the ` +
    `running Gateway without a restart (with gateway.reload.mode "off", run ` +
    `\`openclaw plugins reload ${params.pluginId}\`). ` +
    `To keep the hook blocked without this error, set it to false. ` +
    `Verify with \`openclaw plugins inspect ${params.pluginId} --runtime\` or \`/status plugins\`.`
  );
}

/** Hook registrars: legacy internal hooks plus typed hooks and their refusal records. */
export function createHookRegistrars(state: PluginRegistryState) {
  const { registry, pushDiagnostic, reportRegistrationError, reportRegistrationWarning } = state;

  const registerHook = (
    record: PluginRecord,
    events: string | string[],
    handler: InternalHookHandler,
    opts: OpenClawPluginHookOptions | undefined,
    config: OpenClawPluginApi["config"],
    pluginConfig: unknown,
  ) => {
    const normalizedEvents = normalizeStringEntries(Array.isArray(events) ? events : [events]);
    // Typed lifecycle names (before_tool_call, message_received, ...) are dispatched only by
    // the typed hook runner; registerHook uses the legacy internal-hook path so they never
    // fire. Warn so authors move to `api.on(...)` instead of trusting a false "loaded".
    for (const event of normalizedEvents) {
      if (isPluginHookName(event)) {
        reportRegistrationWarning(
          record,
          `hook event "${event}" is dispatched by the typed hook runner only; ` +
            `api.registerHook registrations for it are not invoked. ` +
            `Use api.on("${event}", ...) instead.`,
        );
      }
    }
    const entry = opts?.entry ?? null;
    const hookName = entry?.hook.name ?? opts?.name?.trim();
    if (!hookName) {
      throw new Error("hook registration missing name");
    }
    const existingHook = registry.hooks.find(
      (entryLocal) => entryLocal.entry.hook.name === hookName,
    );
    if (existingHook) {
      reportRegistrationError(
        record,
        `hook already registered: ${hookName} (${existingHook.pluginId})`,
      );
      return;
    }
    const description = entry?.hook.description ?? opts?.description ?? "";
    const hookEntry: HookEntry = {
      ...(entry ?? { frontmatter: {}, invocation: { enabled: true } }),
      hook: {
        ...(entry?.hook ?? {
          filePath: record.source,
          baseDir: path.dirname(record.source),
          handlerPath: record.source,
        }),
        name: hookName,
        description,
        source: "openclaw-plugin",
        pluginId: record.id,
      },
      metadata: { ...entry?.metadata, events: normalizedEvents },
    };
    record.hookNames.push(hookName);
    registry.hooks.push({
      pluginId: record.id,
      entry: hookEntry,
      events: normalizedEvents,
      source: record.source,
    });
    const hookSystemEnabled = config?.hooks?.internal?.enabled !== false;
    if (!hookSystemEnabled || opts?.register === false) {
      return;
    }
    for (const event of normalizedEvents) {
      const wrappedHandler: typeof handler = async (evt) => {
        const context = evt.context;
        const hadPluginConfig = Object.hasOwn(context, "pluginConfig");
        const previousPluginConfig = context.pluginConfig;
        // Internal hooks share one context; restore per-plugin config after each handler.
        context.pluginConfig = pluginConfig;
        try {
          return await handler({ ...evt, context });
        } finally {
          if (hadPluginConfig) {
            context.pluginConfig = previousPluginConfig;
          } else {
            delete context.pluginConfig;
          }
        }
      };
      registry.legacyInternalHooks.push({
        pluginId: record.id,
        name: hookName,
        event,
        handler: wrappedHandler,
      });
    }
  };

  const registerTypedHook = <K extends PluginHookName>(
    record: PluginRecord,
    hookName: K,
    handler: PluginHookHandlerMap[K],
    opts?: PluginHookRegistrationOptions<K>,
    policy?: PluginTypedHookPolicy,
  ) => {
    if (!isPluginHookName(hookName)) {
      reportRegistrationWarning(record, `unknown typed hook "${String(hookName)}" ignored`);
      return;
    }
    // Records the refusal on the registry as well as emitting the diagnostic, so
    // "is any hook of mine refused?" stays answerable after the startup scroll
    // is gone. `api.on()` returns void, so the plugin itself can never observe
    // that its handler was refused.
    const blockTypedHook = (params: {
      reason: PluginBlockedHookReason;
      severity: "warn" | "error";
      configPath: string;
      message: string;
    }) => {
      pushDiagnostic({
        level: params.severity,
        pluginId: record.id,
        source: record.source,
        code: "hook-registration-blocked",
        message: params.message,
      });
      registry.blockedHooks.push({
        pluginId: record.id,
        hookName,
        reason: params.reason,
        severity: params.severity,
        configPath: params.configPath,
        message: params.message,
        source: record.source,
      });
    };
    if (!resolvePromptInjectionAllowed(policy) && isPromptInjectionHookName(hookName)) {
      // Deliberate operator configuration: stays a warning.
      const configPath = `plugins.entries.${record.id}.hooks.allowPromptModification`;
      blockTypedHook({
        reason: "prompt-injection-denied",
        severity: "warn",
        configPath,
        message:
          `typed hook "${hookName}" blocked by ${configPath}=false; ` +
          `the handler is not registered and will never run`,
      });
      return;
    }
    const conversationAccessAllowed = resolveConversationAccessAllowed(record.origin, policy);
    if (PLUGIN_HOOK_METADATA[hookName].conversationAccess && !conversationAccessAllowed) {
      const configPath = `plugins.entries.${record.id}.hooks.allowConversationAccess`;
      // An operator who wrote `false` chose this outcome, whatever the plugin's
      // origin, so it stays a warning. This check must come first: a non-bundled
      // plugin with an explicit `false` also satisfies the implicit-deny
      // condition below, and reporting that as an error would raise the severity
      // of a decision the operator made and tell them to set a key they already
      // set.
      if (policy?.allowConversationAccess === false) {
        blockTypedHook({
          reason: "conversation-access-denied",
          severity: "warn",
          configPath,
          message:
            `typed hook "${hookName}" blocked by ${configPath}=false; ` +
            `the handler is not registered and will never run`,
        });
        return;
      }
      // Implicit deny: nobody expressed an opinion. See the formatter's note.
      blockTypedHook({
        reason: "conversation-access-missing",
        severity: "error",
        configPath,
        message: formatImplicitConversationAccessBlockDiagnostic({
          pluginId: record.id,
          hookName,
          configPath,
        }),
      });
      return;
    }
    const timeoutMs = resolveTypedHookTimeoutMs({ hookName, opts, policy });
    const eligibleTriggers =
      hookName === "before_agent_reply"
        ? normalizeHookEligibility(opts?.eligibleTriggers, isPluginHookAgentTrigger)
        : undefined;
    const eligibleDispatchKinds =
      hookName === "reply_dispatch"
        ? normalizeHookEligibility(opts?.eligibleDispatchKinds, isPluginHookReplyDispatchKind)
        : undefined;
    const matcher =
      hookName === "before_tool_call" || hookName === "after_tool_call"
        ? normalizePluginToolMatcher(opts?.matcher)
        : undefined;
    if (opts?.matcher && hookName !== "before_tool_call" && hookName !== "after_tool_call") {
      reportRegistrationWarning(record, `typed hook "${hookName}" ignores tool matcher`);
    }
    record.hookCount += 1;
    registry.typedHooks.push({
      pluginId: record.id,
      ...(opts?.registrationId ? { registrationId: opts.registrationId } : {}),
      hookName,
      handler,
      ...(matcher ? { matcher } : {}),
      priority: opts?.priority,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(eligibleTriggers ? { eligibleTriggers } : {}),
      ...(eligibleDispatchKinds ? { eligibleDispatchKinds } : {}),
      ...(hookName === "before_prompt_build" && opts?.requiresToolAuthority === true
        ? { requiresToolAuthority: true }
        : {}),
      ...(hookName === "session_end" && conversationAccessAllowed
        ? { conversationAccessAllowed: true }
        : {}),
      source: record.source,
    });
  };

  return { registerHook, registerTypedHook };
}
