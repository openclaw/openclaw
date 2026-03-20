import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RUNTIME_API_EXPORT_GUARDS: Record<string, readonly string[]> = {
  "extensions/discord/runtime-api.ts": [
    'export * from "./src/audit.js";',
    'export * from "./src/actions/runtime.js";',
    'export * from "./src/actions/runtime.moderation-shared.js";',
    'export * from "./src/actions/runtime.shared.js";',
    'export * from "./src/channel-actions.js";',
    'export * from "./src/directory-live.js";',
    'export * from "./src/monitor.js";',
    'export * from "./src/monitor/gateway-plugin.js";',
    'export * from "./src/monitor/gateway-registry.js";',
    'export * from "./src/monitor/presence-cache.js";',
    'export * from "./src/monitor/thread-bindings.js";',
    'export * from "./src/monitor/thread-bindings.manager.js";',
    'export * from "./src/monitor/timeouts.js";',
    'export * from "./src/probe.js";',
    'export * from "./src/resolve-channels.js";',
    'export * from "./src/resolve-users.js";',
    'export * from "./src/send.js";',
  ],
  "extensions/imessage/runtime-api.ts": [
    'export { DEFAULT_ACCOUNT_ID, PAIRING_APPROVED_MESSAGE, buildChannelConfigSchema, collectStatusIssuesFromLastError, formatTrimmedAllowFromEntries, getChatChannelMeta, looksLikeIMessageTargetId, normalizeIMessageMessagingTarget, resolveChannelMediaMaxBytes, resolveIMessageConfigAllowFrom, resolveIMessageConfigDefaultTo, IMessageConfigSchema, type ChannelPlugin, type IMessageAccountConfig } from "openclaw/plugin-sdk/imessage";',
    'export { resolveIMessageGroupRequireMention, resolveIMessageGroupToolPolicy } from "./src/group-policy.js";',
    'export { monitorIMessageProvider } from "./src/monitor.js";',
    'export type { MonitorIMessageOpts } from "./src/monitor.js";',
    'export { probeIMessage } from "./src/probe.js";',
    'export { sendMessageIMessage } from "./src/send.js";',
  ],
  "extensions/googlechat/runtime-api.ts": ['export * from "openclaw/plugin-sdk/googlechat";'],
  "extensions/matrix/runtime-api.ts": [
    'export * from "./src/auth-precedence.js";',
    'export * from "./helper-api.js";',
  ],
  "extensions/nextcloud-talk/runtime-api.ts": [
    'export * from "openclaw/plugin-sdk/nextcloud-talk";',
  ],
  "extensions/signal/runtime-api.ts": ['export * from "./src/runtime-api.js";'],
  "extensions/slack/runtime-api.ts": [
    'export * from "./src/action-runtime.js";',
    'export * from "./src/directory-live.js";',
    'export * from "./src/index.js";',
    'export * from "./src/resolve-channels.js";',
    'export * from "./src/resolve-users.js";',
  ],
  "extensions/telegram/runtime-api.ts": [
    'export type { ChannelMessageActionAdapter, ChannelPlugin, OpenClawConfig, OpenClawPluginApi, PluginRuntime, TelegramAccountConfig, TelegramActionConfig, TelegramNetworkConfig } from "openclaw/plugin-sdk/telegram";',
    'export type { OpenClawPluginService, OpenClawPluginServiceContext, PluginLogger } from "openclaw/plugin-sdk/core";',
    'export type { AcpRuntime, AcpRuntimeCapabilities, AcpRuntimeDoctorReport, AcpRuntimeEnsureInput, AcpRuntimeEvent, AcpRuntimeHandle, AcpRuntimeStatus, AcpRuntimeTurnInput, AcpRuntimeErrorCode, AcpSessionUpdateTag } from "openclaw/plugin-sdk/acp-runtime";',
    'export { AcpRuntimeError } from "openclaw/plugin-sdk/acp-runtime";',
    'export { buildTokenChannelStatusSummary, clearAccountEntryFields, DEFAULT_ACCOUNT_ID, normalizeAccountId, PAIRING_APPROVED_MESSAGE, parseTelegramTopicConversation, projectCredentialSnapshotFields, resolveConfiguredFromCredentialStatuses, resolveTelegramPollVisibility } from "openclaw/plugin-sdk/telegram";',
    'export { buildChannelConfigSchema, getChatChannelMeta, jsonResult, readNumberParam, readReactionParams, readStringArrayParam, readStringOrNumberParam, readStringParam, resolvePollMaxSelections, TelegramConfigSchema } from "openclaw/plugin-sdk/telegram-core";',
    'export type { TelegramProbe } from "./src/probe.js";',
    'export { auditTelegramGroupMembership, collectTelegramUnmentionedGroupIds } from "./src/audit.js";',
    'export { telegramMessageActions } from "./src/channel-actions.js";',
    'export { monitorTelegramProvider } from "./src/monitor.js";',
    'export { probeTelegram } from "./src/probe.js";',
    'export { createForumTopicTelegram, deleteMessageTelegram, editForumTopicTelegram, editMessageReplyMarkupTelegram, editMessageTelegram, pinMessageTelegram, reactMessageTelegram, renameForumTopicTelegram, sendMessageTelegram, sendPollTelegram, sendStickerTelegram, sendTypingTelegram, unpinMessageTelegram } from "./src/send.js";',
    'export { createTelegramThreadBindingManager, getTelegramThreadBindingManager, setTelegramThreadBindingIdleTimeoutBySessionKey, setTelegramThreadBindingMaxAgeBySessionKey } from "./src/thread-bindings.js";',
    'export { resolveTelegramToken } from "./src/token.js";',
  ],
  "extensions/whatsapp/runtime-api.ts": [
    'export * from "./src/active-listener.js";',
    'export * from "./src/action-runtime.js";',
    'export * from "./src/agent-tools-login.js";',
    'export * from "./src/auth-store.js";',
    'export * from "./src/auto-reply.js";',
    'export * from "./src/inbound.js";',
    'export * from "./src/login.js";',
    'export * from "./src/login-qr.js";',
    'export * from "./src/media.js";',
    'export * from "./src/send.js";',
    'export * from "./src/session.js";',
  ],
} as const;

function collectRuntimeApiFiles(): string[] {
  const extensionsDir = resolve(ROOT_DIR, "..", "extensions");
  const files: string[] = [];
  const stack = [extensionsDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== "runtime-api.ts") {
        continue;
      }
      files.push(relative(resolve(ROOT_DIR, ".."), fullPath).replaceAll("\\", "/"));
    }
  }
  return files;
}

function readExportStatements(path: string): string[] {
  const sourceText = readFileSync(resolve(ROOT_DIR, "..", path), "utf8");
  const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);

  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement)) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        return [];
      }
      return [statement.getText(sourceFile).replaceAll(/\s+/g, " ").trim()];
    }

    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
      return [statement.getText(sourceFile).replaceAll(/\s+/g, " ").trim()];
    }

    if (!statement.exportClause) {
      const prefix = statement.isTypeOnly ? "export type *" : "export *";
      return [`${prefix} from ${moduleSpecifier.getText(sourceFile)};`];
    }

    if (!ts.isNamedExports(statement.exportClause)) {
      return [statement.getText(sourceFile).replaceAll(/\s+/g, " ").trim()];
    }

    const specifiers = statement.exportClause.elements.map((element) => {
      const imported = element.propertyName?.text;
      const exported = element.name.text;
      const alias = imported ? `${imported} as ${exported}` : exported;
      return element.isTypeOnly ? `type ${alias}` : alias;
    });
    const exportPrefix = statement.isTypeOnly ? "export type" : "export";
    return [
      `${exportPrefix} { ${specifiers.join(", ")} } from ${moduleSpecifier.getText(sourceFile)};`,
    ];
  });
}

describe("runtime api guardrails", () => {
  it("keeps runtime api surfaces on an explicit export allowlist", () => {
    const runtimeApiFiles = collectRuntimeApiFiles();
    expect(runtimeApiFiles).toEqual(
      expect.arrayContaining(Object.keys(RUNTIME_API_EXPORT_GUARDS).toSorted()),
    );

    for (const file of Object.keys(RUNTIME_API_EXPORT_GUARDS).toSorted()) {
      expect(readExportStatements(file), `${file} runtime api exports changed`).toEqual(
        RUNTIME_API_EXPORT_GUARDS[file],
      );
    }
  });
});
