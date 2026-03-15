import { registerInternalHook, type InternalHookHandler } from "../hooks/internal-hooks.js";
import type {
  PluginHookHandlerMap,
  PluginHookName,
  PluginHookRegistration as TypedPluginHookRegistration,
} from "../plugins/types.js";
import {
  isPromptInjectionHookName,
  stripPromptMutationFieldsFromLegacyHookResult,
} from "../plugins/types.js";

export function constrainExtensionHostPromptInjectionHook(
  handler: PluginHookHandlerMap["before_agent_start"],
): PluginHookHandlerMap["before_agent_start"] {
  return (event, ctx) => {
    const result = handler(event, ctx);
    if (result && typeof result === "object" && "then" in result) {
      return Promise.resolve(result).then((resolved) =>
        stripPromptMutationFieldsFromLegacyHookResult(resolved),
      );
    }
    return stripPromptMutationFieldsFromLegacyHookResult(result);
  };
}

export function bridgeExtensionHostLegacyHooks(params: {
  events: string[];
  handler: InternalHookHandler;
  hookSystemEnabled: boolean;
  register?: boolean;
  registerHook?: typeof registerInternalHook;
}): void {
  if (!params.hookSystemEnabled || params.register === false) {
    return;
  }

  const registerHook = params.registerHook ?? registerInternalHook;
  for (const event of params.events) {
    registerHook(event, params.handler);
  }
}

export function applyExtensionHostTypedHookPolicy<K extends PluginHookName>(params: {
  hookName: K;
  handler: PluginHookHandlerMap[K];
  policy?: {
    allowPromptInjection?: boolean;
  };
  blockedMessage: string;
  constrainedMessage: string;
}):
  | {
      ok: false;
      message: string;
    }
  | {
      ok: true;
      entryHandler: TypedPluginHookRegistration["handler"];
      warningMessage?: string;
    } {
  if (
    !(params.policy?.allowPromptInjection === false && isPromptInjectionHookName(params.hookName))
  ) {
    return {
      ok: true,
      entryHandler: params.handler,
    };
  }

  if (params.hookName === "before_prompt_build") {
    return {
      ok: false,
      message: params.blockedMessage,
    };
  }

  if (params.hookName === "before_agent_start") {
    return {
      ok: true,
      entryHandler: constrainExtensionHostPromptInjectionHook(
        params.handler as PluginHookHandlerMap["before_agent_start"],
      ),
      warningMessage: params.constrainedMessage,
    };
  }

  return {
    ok: true,
    entryHandler: params.handler,
  };
}
