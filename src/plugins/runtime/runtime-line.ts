import { loadSiblingRuntimeModuleSync } from "./local-runtime-module.js";
import type { PluginRuntimeChannel } from "./types-channel.js";

type RuntimeLineModule = {
  runtimeLine: PluginRuntimeChannel["line"];
};

let cachedRuntimeLineModule: RuntimeLineModule | null = null;

function loadRuntimeLineModule(): RuntimeLineModule {
  cachedRuntimeLineModule ??= loadSiblingRuntimeModuleSync<RuntimeLineModule>({
    moduleUrl: import.meta.url,
    relativeBase: "./runtime-line.contract",
  });
  return cachedRuntimeLineModule;
}

export function createRuntimeLine(): PluginRuntimeChannel["line"] {
  return {
    listLineAccountIds: (...args) =>
      loadRuntimeLineModule().runtimeLine.listLineAccountIds(...args),
    resolveDefaultLineAccountId: (...args) =>
      loadRuntimeLineModule().runtimeLine.resolveDefaultLineAccountId(...args),
    resolveLineAccount: (...args) =>
      loadRuntimeLineModule().runtimeLine.resolveLineAccount(...args),
    normalizeAccountId: (...args) =>
      loadRuntimeLineModule().runtimeLine.normalizeAccountId(...args),
    probeLineBot: (...args) => loadRuntimeLineModule().runtimeLine.probeLineBot(...args),
    sendMessageLine: (...args) => loadRuntimeLineModule().runtimeLine.sendMessageLine(...args),
    pushMessageLine: (...args) => loadRuntimeLineModule().runtimeLine.pushMessageLine(...args),
    pushMessagesLine: (...args) => loadRuntimeLineModule().runtimeLine.pushMessagesLine(...args),
    pushFlexMessage: (...args) => loadRuntimeLineModule().runtimeLine.pushFlexMessage(...args),
    pushTemplateMessage: (...args) =>
      loadRuntimeLineModule().runtimeLine.pushTemplateMessage(...args),
    pushLocationMessage: (...args) =>
      loadRuntimeLineModule().runtimeLine.pushLocationMessage(...args),
    pushTextMessageWithQuickReplies: (...args) =>
      loadRuntimeLineModule().runtimeLine.pushTextMessageWithQuickReplies(...args),
    createQuickReplyItems: (...args) =>
      loadRuntimeLineModule().runtimeLine.createQuickReplyItems(...args),
    buildTemplateMessageFromPayload: (...args) =>
      loadRuntimeLineModule().runtimeLine.buildTemplateMessageFromPayload(...args),
    monitorLineProvider: (...args) =>
      loadRuntimeLineModule().runtimeLine.monitorLineProvider(...args),
  };
}
