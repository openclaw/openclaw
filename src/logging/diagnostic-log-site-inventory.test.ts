// Diagnostic log inventory tests keep OTEL log-record coverage visible.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PRODUCTION_ROOTS = ["src", "extensions", "packages", "ui"] as const;
const BROAD_PRODUCTION_ROOTS = PRODUCTION_ROOTS;
const LOG_METHODS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "raw"]);
const TEST_FILE_RE = /(?:\.test|\.spec|\.d)\.tsx?$/u;
const EXCLUDED_DIRS = new Set([
  ".artifacts",
  ".git",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
]);
const TS_SOURCE_FILE_RE = /\.tsx?$/u;
const SUBSYSTEM_LOGGER_RE = /\bcreateSubsystemLogger\s*\(/gu;
const CHILD_LOGGER_RE = /\bgetChildLogger\s*\(/gu;
const EXPLICIT_LOG_SEMANTICS_RE = /\b(?:attachDiagnosticLogSemantics|heartbeatLogMeta)\s*\(/gu;
const TRUSTED_SECURITY_EVENT_RE = /\bemitTrustedSecurityEvent\s*\(/gu;
const INJECTED_LOGGER_CALL_RE =
  /\b(?:api|ctx|params|this)?\.?logger\.(?:trace|debug|info|warn|error|fatal)\s*\(/gu;
const EXPLICIT_SEMANTIC_HELPERS = new Set([
  "attachDiagnosticLogSemantics",
  "heartbeatLogMeta",
  "cronDeliveryLogMeta",
  "cronLogMeta",
  "cronNotificationLogMeta",
]);
const FIRST_ARGUMENT_EVENT_SEMANTIC_HELPERS = new Set(["hookLogSemantics"]);
const LOG_HELPER_EVENT_ARGUMENT_INDEX = new Map([
  ["logHookDebug", 1],
  ["logHookWarn", 1],
  ["logHookError", 1],
]);
const EXPLICIT_SEMANTIC_PRODUCER_HELPERS = new Set([
  "attachPinoForwardLogMeta",
  "approvalRuntimeLogSemantics",
  "consoleForwardLogMeta",
  "runtimeLlmLogMeta",
]);
const MAX_EXPLICIT_LOG_EVENT_NAME_LENGTH = 54;
const DETAIL_EVENT_NAME_SEGMENTS = new Set([
  "delayms",
  "messageid",
  "ms",
  "olddelayms",
  "pendingreason",
  "queuesize",
  "reason",
  "runid",
  "s",
  "sessionid",
  "sessionkey",
  "timeoutms",
  "waitms",
]);
const OUTCOME_EVENT_NAME_SEGMENTS = new Set([
  "blocked",
  "cancelled",
  "created",
  "denied",
  "disabled",
  "discarded",
  "enabled",
  "error",
  "exceeded",
  "failed",
  "failure",
  "fallback",
  "invalid",
  "missing",
  "oversized",
  "retries",
  "retry",
  "retrying",
  "ready",
  "selected",
  "sent",
  "skipped",
  "started",
  "success",
  "succeeded",
  "completed",
  "cleanly",
  "timed",
  "timeout",
  "threw",
  "truncating",
  "unsupported",
  "unavailable",
  "warning",
]);
const PROSE_EVENT_NAME_SEGMENTS = new Set([
  "aborting",
  "already",
  "cannot",
  "could",
  "doesn",
  "become",
  "first",
  "fresh",
  "gave",
  "may",
  "produced",
  "reached",
  "times",
]);
const PROSE_EVENT_NAME_SEQUENCES = [
  ["did", "not", "become"],
  ["falling", "back"],
  ["fell", "back"],
] as const;
const NON_SUCCESS_REASON_CODES = new Set([
  "blocked",
  "cancelled",
  "denied",
  "error",
  "failed",
  "failure",
  "fallback",
  "invalid",
  "missing",
  "provider_minimum",
  "retry",
  "skipped",
  "timeout",
  "transcript_missing",
  "unavailable",
  "warning",
]);
const SUCCESS_REASON_CODES = new Set([
  "completed",
  "connected",
  "received",
  "registered",
  "resolved",
  "stopped",
]);
const DIAGNOSTIC_LOG_OUTCOMES = new Set(["failure", "success", "warning"]);
const IMPLEMENTATION_EVENT_NAME_RE =
  /(?:agentcommandinternal|audittoolpolicyfilter|buildguardedmodelfetch|collect[a-z0-9]{8,}|compactionsafeguardextension|create[a-z0-9]{8,}|debugskillcommandonce|emit[a-z0-9]{8,}|generateslugviallm|initsessionstateattemptlocked|loadbundlesettingsfile|logpluginbindinglifecycleevent|logresponsesfailednodetails|logwsinfoline|logwsoptimized|maybe[a-z0-9]{8,}|oncrash|onfailure|onsigusr1|onsubagentended|onwakefailure|onwarn|resolve[a-z0-9]{8,}|rungatewayloop|schedulewaitretry|spawn[a-z0-9]{8,}|traceskillcommandonce|warnprocesssupervisorspawnfailure|write[a-z0-9]{8,})/u;
const INJECTED_LOGGER_EXEMPTIONS = {
  "src/agents/tools/transcripts-tool.ts:warn:ctx.logger:7df4e687f44e": "operator_output_callback",
  "src/agents/tools/transcripts-tool.ts:warn:ctx.logger:95b3810de39a": "operator_output_callback",
  "src/agents/tools/transcripts-tool.ts:warn:ctx.logger:a73dc3b90917": "operator_output_callback",
  "src/auto-reply/reply/commands-plugins.ts:warn:logger:ebc7f2308aa4": "operator_output_callback",
  "src/cli/plugins-registry-refresh.ts:warn:params.logger:d305dfb1935f": "operator_output_callback",
  "src/cli/plugins-registry-refresh.ts:warn:params.logger:3eb93728a42d": "operator_output_callback",
  "src/config/io.clobber-snapshot.ts:warn:deps.logger:cec59b40a98c": "operator_output_callback",
  "src/config/io.health-state.ts:warn:deps.logger:66e8e7048866": "operator_output_callback",
  "src/config/io.invalid-config.ts:error:params.logger:873dfef6f457": "operator_output_callback",
  "src/config/io.observe-recovery.ts:warn:params.deps.logger:107ed9c35df1":
    "operator_output_callback",
  "src/config/io.observe-recovery.ts:warn:params.deps.logger:637dd47d60c3":
    "operator_output_callback",
  "src/config/io.observe-recovery.ts:warn:params.logger:91ab10ba7b47": "operator_output_callback",
  "src/config/io.observe-recovery.ts:warn:deps.logger:32d4c0f4529c": "operator_output_callback",
  "src/config/io.observe-recovery.ts:warn:deps.logger:c23122b4132c": "operator_output_callback",
  "src/config/io.observe-recovery.ts:warn:deps.logger:1237096b6638": "operator_output_callback",
  "src/config/io.ts:warn:deps.logger:0772a278df0b": "operator_output_callback",
  "src/config/io.ts:warn:deps.logger:0772a278df0b#2": "operator_output_callback",
  "src/config/io.ts:warn:logger:8f0247fe1219": "operator_output_callback",
  "src/config/io.ts:warn:logger:b7ebc2db847f": "operator_output_callback",
  "src/config/io.ts:warn:params.deps.logger:f7f219ca4e23": "operator_output_callback",
  "src/config/io.ts:warn:deps.logger:2ab1f6101e61": "operator_output_callback",
  "src/config/io.ts:warn:deps.logger:77717ef45c57": "operator_output_callback",
  "src/config/io.ts:warn:deps.logger:0b40e49d55db": "operator_output_callback",
  "src/config/io.ts:error:deps.logger:6ae37d10135a": "operator_output_callback",
  "src/config/io.ts:error:deps.logger:d8a9e2dad0e1": "operator_output_callback",
  "src/config/io.ts:error:deps.logger:46f31ce00084": "operator_output_callback",
  "src/config/io.ts:warn:deps.logger:0b40e49d55db#2": "operator_output_callback",
  "src/config/io.ts:warn:deps.logger:73ecfd22254a": "operator_output_callback",
  "src/config/io.ts:warn:deps.logger:08959cf018b2": "operator_output_callback",
  "src/config/io.ts:warn:deps.logger:9b22010fe5ae": "operator_output_callback",
  "src/hooks/install.ts:info:logger:014e388ab17e": "operator_output_callback",
  "src/hooks/install.ts:warn:logger:893160129afe": "operator_output_callback",
  "src/hooks/update.ts:warn:params.logger:045f56d70388": "operator_output_callback",
  "src/infra/clawhub-install-trust.ts:warn:params.logger:39ef8d8ad265": "operator_output_callback",
  "src/infra/install-flow.ts:info:params.logger:2fabd6f6bc32": "operator_output_callback",
  "src/infra/install-package-dir.ts:info:params.logger:17e3929a2537": "operator_output_callback",
  "src/infra/install-package-dir.ts:warn:params.logger:7fb56e45351a": "operator_output_callback",
  "src/infra/install-package-dir.ts:warn:params.logger:7fb56e45351a#2": "operator_output_callback",
  "src/infra/install-package-dir.ts:info:params.logger:4a8baf16def1": "operator_output_callback",
  "src/infra/install-package-dir.ts:warn:params.logger:4ad8a2a78979": "operator_output_callback",
  "src/infra/npm-managed-root.ts:warn:params.logger:00573d1d1ee1": "operator_output_callback",
  "src/infra/npm-managed-root.ts:warn:params.logger:cba25179ac46": "operator_output_callback",
  "src/infra/shell-env.ts:warn:logger:e8ed35e6e201": "operator_output_callback",
  "src/infra/state-migrations.ts:info:logger:724d938e3df9": "operator_output_callback",
  "src/infra/state-migrations.ts:warn:logger:27d8dd5ea784": "operator_output_callback",
  "src/infra/state-migrations.ts:info:logger:4ade046b10af": "operator_output_callback",
  "src/infra/state-migrations.ts:warn:logger:27d8dd5ea784#2": "operator_output_callback",
  "src/plugin-sdk/runtime-logger.ts:info:params.logger:67be8cf48da4": "compat_runtime_adapter",
  "src/plugin-sdk/runtime-logger.ts:error:params.logger:0bca2d7f28a5": "compat_runtime_adapter",
  "src/plugin-sdk/runtime-logger.ts:info:params.logger:2b8fb09fe8c1": "compat_runtime_adapter",
  "src/plugin-sdk/runtime-logger.ts:info:params.logger:6af3b7f9049c": "compat_runtime_adapter",
  "src/plugins/clawhub.ts:info:params.logger:ac1a15bdfca8": "operator_output_callback",
  "src/plugins/clawhub.ts:info:params.logger:9bbc484a5183": "operator_output_callback",
  "src/plugins/clawhub.ts:warn:params.logger:1d86b1ffb0d9": "operator_output_callback",
  "src/plugins/clawhub.ts:info:params.logger:0e385844721c": "operator_output_callback",
  "src/plugins/git-install.ts:info:params.logger:1deeb7eefc79": "operator_output_callback",
  "src/plugins/git-install.ts:info:params.logger:0dc54c22590a": "operator_output_callback",
  "src/plugins/install-security-scan.runtime.ts:warn:params.logger:e9ab04cefbbf":
    "operator_output_callback",
  "src/plugins/install-security-scan.runtime.ts:warn:params.logger:e9ab04cefbbf#2":
    "operator_output_callback",
  "src/plugins/install-security-scan.runtime.ts:warn:params.logger:e9ab04cefbbf#3":
    "operator_output_callback",
  "src/plugins/install-security-scan.runtime.ts:warn:params.logger:7d6ff7e34f80":
    "operator_output_callback",
  "src/plugins/install-security-scan.runtime.ts:warn:params.logger:b47e8047fe7a":
    "operator_output_callback",
  "src/plugins/install-security-scan.runtime.ts:warn:params.logger:a34d6d353d23":
    "operator_output_callback",
  "src/plugins/install-security-scan.runtime.ts:warn:params.logger:b342da3b5f41":
    "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:65ac3c13b561": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:dfe32df2dc10": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:37f78ef43c5e": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:af21cab98cfa": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:83a154c0a951": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:355781f792e6": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:2121a65847e6": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:0b9b90ee342e": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:04543aa3a949": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:1dca0b3d11cc": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:0577ea9a4f26": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:3663cb3313c5": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:3054000ae2eb": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:55f01f98c768": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:ba0fef985999": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:7f9000fed15e": "operator_output_callback",
  "src/plugins/install.ts:warn:params.logger:3478a3e5df63": "operator_output_callback",
  "src/plugins/install.ts:info:logger:08b3d8ff4c07": "operator_output_callback",
  "src/plugins/install.ts:info:logger:3e4b8b9dd07a": "operator_output_callback",
  "src/plugins/install.ts:warn:logger:e8586b323c31": "operator_output_callback",
  "src/plugins/install.ts:warn:logger:b7ad649671f6": "operator_output_callback",
  "src/plugins/install.ts:warn:logger:117faf5689af": "operator_output_callback",
  "src/plugins/install.ts:warn:logger:508646b7c144": "operator_output_callback",
  "src/plugins/install.ts:info:logger:8819c85fa002": "operator_output_callback",
  "src/plugins/install.ts:info:params.logger:c23480dcc6a4": "operator_output_callback",
  "src/plugins/install.ts:info:logger:fe88c8205946": "operator_output_callback",
  "src/plugins/install.ts:warn:logger:893160129afe": "operator_output_callback",
  "src/plugins/install.ts:warn:logger:893160129afe#2": "operator_output_callback",
  "src/plugins/marketplace.ts:info:params.logger:b910574a6f94": "operator_output_callback",
  "src/plugins/plugin-peer-link.ts:warn:params.logger:6700b3076bc6": "operator_output_callback",
  "src/plugins/plugin-peer-link.ts:warn:params.logger:6700b3076bc6#2": "operator_output_callback",
  "src/plugins/plugin-peer-link.ts:info:params.logger:9bcf573ca73c": "operator_output_callback",
  "src/plugins/plugin-peer-link.ts:warn:params.logger:d15400d9b3da": "operator_output_callback",
  "src/plugins/plugin-peer-link.ts:info:params.logger:dc59a4f48833": "operator_output_callback",
  "src/plugins/plugin-peer-link.ts:warn:params.logger:1e21da823cb1": "operator_output_callback",
  "src/plugins/plugin-peer-link.ts:warn:params.logger:02be597cfe37": "operator_output_callback",
  "src/plugins/update.ts:warn:params.logger:3b5b1d0fe98b": "operator_output_callback",
  "src/plugins/update.ts:warn:params.logger:ae60004ed2ae": "operator_output_callback",
  "src/plugins/update.ts:info:params.logger:14ecb9e34fa4": "operator_output_callback",
  "src/plugins/update.ts:warn:params.logger:51facd9ffdcf": "operator_output_callback",
  "src/plugins/update.ts:warn:params.logger:aa7f19caadbf": "operator_output_callback",
  "src/plugins/update.ts:warn:logger:db27ba2b80d9": "operator_output_callback",
  "src/plugins/update.ts:warn:logger:265be03d4b2b": "operator_output_callback",
  "src/plugins/update.ts:warn:logger:9a0a6ea42ad5": "operator_output_callback",
  "src/plugins/update.ts:warn:logger:3f76316e7e26": "operator_output_callback",
  "src/plugins/update.ts:warn:logger:0831cc01c6ed": "operator_output_callback",
  "src/plugins/update.ts:warn:logger:9f1494cb363d": "operator_output_callback",
  "src/plugins/update.ts:warn:logger:67c91855f327": "operator_output_callback",
  "src/plugins/update.ts:warn:logger:0831cc01c6ed#2": "operator_output_callback",
  "src/plugins/update.ts:warn:logger:9f1494cb363d#2": "operator_output_callback",
  "src/plugins/update.ts:error:logger:05be6d920fd4": "operator_output_callback",
  "src/plugins/update.ts:warn:logger:169934effc65": "operator_output_callback",
  "src/plugins/update.ts:error:logger:05be6d920fd4#2": "operator_output_callback",
  "src/security/install-policy.ts:warn:params.logger:97326e595699": "operator_output_callback",
  "src/security/install-policy.ts:debug:params.logger:ccb41c1c6deb": "operator_output_callback",
  "src/skills/lifecycle/clawhub.ts:info:params.logger:e82bfb3b3949": "operator_output_callback",
  "src/skills/lifecycle/clawhub.ts:info:params.logger:6539d9e477de": "operator_output_callback",
  "src/skills/lifecycle/clawhub.ts:info:params.logger:e82bfb3b3949#2": "operator_output_callback",
  "src/skills/lifecycle/source-install.ts:info:params.logger:1deeb7eefc79":
    "operator_output_callback",
  "src/wizard/setup.migration-import.ts:debug:logger:8e4d1240b48a": "operator_output_callback",
  "src/wizard/setup.post-install-migration.ts:debug:logger:ed7dbae7c25a":
    "operator_output_callback",
} as const satisfies Record<string, "compat_runtime_adapter" | "operator_output_callback">;
// Extension plugin loggers still accept free-text plugin output. They are not counted
// as core-owned missing semantics, but the exact source set is pinned so new sites
// cannot appear without an intentional structured-semantic decision.
const EXTENSION_PLUGIN_FREE_TEXT_FALLBACK = {
  knownCount: 382,
  knownFingerprint: "8ed0750b44745cd1",
  injectedCount: 428,
  injectedFingerprint: "695ee489eac02cbb",
} as const;

type KnownSubsystemLogCall = {
  file: string;
  line: number;
  method: string;
  subsystem: string;
  hasExplicitEvent: boolean;
  explicitEventNames: string[];
};

type InjectedLoggerCall = {
  file: string;
  line: number;
  method: string;
  receiver: string;
  exemptionKey: string;
  hasExplicitEvent: boolean;
  explicitEventNames: string[];
};

type DirectRootLoggerCall = {
  file: string;
  line: number;
  method: string;
  hasExplicitEvent: boolean;
  explicitEventNames: string[];
};

type SemanticLogHelperCall = {
  file: string;
  line: number;
  helper: string;
  explicitEventNames: string[];
};

type DiagnosticLogInventory = {
  known: KnownSubsystemLogCall[];
  injected: InjectedLoggerCall[];
  directRoot: DirectRootLoggerCall[];
  semanticHelpers: SemanticLogHelperCall[];
  outcomeReasonProblems: string[];
};

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(entryPath, out);
      continue;
    }
    if (entry.isFile() && TS_SOURCE_FILE_RE.test(entryPath) && !TEST_FILE_RE.test(entryPath)) {
      out.push(entryPath.replace(/\\/gu, "/"));
    }
  }
  return out;
}

function countMatches(sourceText: string, pattern: RegExp): number {
  return Array.from(sourceText.matchAll(pattern)).length;
}

function inventoryBroadDiagnosticLogSources(): {
  files: number;
  subsystemLoggerFactories: number;
  childLoggerFactories: number;
  injectedLoggerCalls: number;
  explicitLogEvents: number;
  trustedSecurityEventEmitters: number;
} {
  const totals = {
    files: 0,
    subsystemLoggerFactories: 0,
    childLoggerFactories: 0,
    injectedLoggerCalls: 0,
    explicitLogEvents: 0,
    trustedSecurityEventEmitters: 0,
  };

  for (const file of BROAD_PRODUCTION_ROOTS.flatMap((root) => walkTsFiles(root))) {
    if (!TS_SOURCE_FILE_RE.test(file)) {
      continue;
    }
    const sourceText = fs.readFileSync(file, "utf8");
    totals.files += 1;
    totals.subsystemLoggerFactories += countMatches(sourceText, SUBSYSTEM_LOGGER_RE);
    totals.childLoggerFactories += countMatches(sourceText, CHILD_LOGGER_RE);
    totals.injectedLoggerCalls += countMatches(sourceText, INJECTED_LOGGER_CALL_RE);
    totals.explicitLogEvents += countMatches(sourceText, EXPLICIT_LOG_SEMANTICS_RE);
    totals.trustedSecurityEventEmitters += countMatches(sourceText, TRUSTED_SECURITY_EVENT_RE);
  }

  // Drop the create/export function declarations; this test tracks emitted log sources.
  totals.subsystemLoggerFactories -= 1;
  totals.childLoggerFactories -= 1;
  totals.trustedSecurityEventEmitters -= 1;
  return totals;
}

function propName(name: ts.Node | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function stringLiteral(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function expressionName(expr: ts.Expression, source: ts.SourceFile): string | undefined {
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const base = expressionName(expr.expression, source) ?? expr.expression.getText(source);
    return `${base}.${expr.name.text}`;
  }
  if (ts.isElementAccessExpression(expr)) {
    const base = expressionName(expr.expression, source) ?? expr.expression.getText(source);
    return `${base}[]`;
  }
  return undefined;
}

function subsystemFromLoggerFactory(
  call: ts.CallExpression,
  bindings: Map<string, string>,
  source: ts.SourceFile,
): string | undefined {
  const expression = call.expression;
  if (ts.isIdentifier(expression) && expression.text === "createSubsystemLogger") {
    return stringLiteral(call.arguments[0]) ?? "<dynamic>";
  }
  if (ts.isIdentifier(expression) && expression.text === "getChildLogger") {
    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      return "<getChildLogger-dynamic>";
    }
    let subsystem: string | undefined;
    let module: string | undefined;
    for (const property of arg.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      const key = propName(property.name);
      const value = stringLiteral(property.initializer) ?? "<dynamic>";
      if (key === "subsystem") {
        subsystem = value;
      } else if (key === "module") {
        module = value;
      }
    }
    return subsystem ?? (module ? `module:${module}` : "<getChildLogger>");
  }
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "child") {
    const parent = bindings.get(expressionName(expression.expression, source) ?? "");
    const child = stringLiteral(call.arguments[0]) ?? "<dynamic-child>";
    return parent ? `${parent}/${child}` : `<child-of:${expression.expression.getText(source)}>`;
  }
  return undefined;
}

function objectLiteralStringProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): string | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || propName(property.name) !== propertyName) {
      continue;
    }
    return stringLiteral(property.initializer);
  }
  return undefined;
}

function objectLiteralHasProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): boolean {
  return object.properties.some(
    (property) => ts.isPropertyAssignment(property) && propName(property.name) === propertyName,
  );
}

function objectLiteralEventName(object: ts.ObjectLiteralExpression): string | undefined {
  return (
    objectLiteralStringProperty(object, "event") ??
    (objectLiteralHasProperty(object, "event") ? "<dynamic>" : undefined)
  );
}

function expressionEventNames(expr: ts.Node, source: ts.SourceFile): string[] {
  if (ts.isObjectLiteralExpression(expr)) {
    const eventName = objectLiteralEventName(expr);
    return eventName ? [eventName] : [];
  }
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) {
    return expressionEventNames(expr.expression, source);
  }
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return [
      ...expressionEventNames(expr.left, source),
      ...expressionEventNames(expr.right, source),
    ];
  }
  if (ts.isConditionalExpression(expr)) {
    return [
      ...expressionEventNames(expr.whenTrue, source),
      ...expressionEventNames(expr.whenFalse, source),
    ];
  }
  if (ts.isSpreadElement(expr)) {
    return expressionEventNames(expr.expression, source);
  }
  if (ts.isCallExpression(expr)) {
    const helperName = expressionName(expr.expression, source) ?? expr.expression.getText(source);
    if (FIRST_ARGUMENT_EVENT_SEMANTIC_HELPERS.has(helperName)) {
      const eventName = stringLiteral(expr.arguments[0]);
      return eventName ? [eventName] : ["<dynamic>"];
    }
    if (EXPLICIT_SEMANTIC_PRODUCER_HELPERS.has(helperName)) {
      return ["<helper>"];
    }
    if (EXPLICIT_SEMANTIC_HELPERS.has(helperName)) {
      const eventNames = expr.arguments.flatMap((arg) => expressionEventNames(arg, source));
      return eventNames.length > 0 ? eventNames : ["<helper>"];
    }
  }
  return [];
}

function explicitLogEventNames(call: ts.CallExpression, source: ts.SourceFile): string[] {
  return call.arguments.flatMap((arg) => expressionEventNames(arg, source));
}

function statementForNode(node: ts.Node): ts.Statement | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isStatement(current)) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function hasReturnStatement(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isReturnStatement(child)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function containsExplicitLoggerCall(
  node: ts.Node,
  source: ts.SourceFile,
  receiver: string,
  method: string,
): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) {
      return;
    }
    if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
      const childMethod = child.expression.name.text;
      const childReceiver =
        expressionName(child.expression.expression, source) ??
        child.expression.expression.getText(source);
      if (
        childMethod === method &&
        childReceiver === receiver &&
        explicitLogEventNames(child, source).length > 0
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isGuardedDiagnosticSemanticsFallbackCall(
  call: ts.CallExpression,
  source: ts.SourceFile,
  receiver: string,
  method: string,
): boolean {
  const statement = statementForNode(call);
  if (!statement || !ts.isBlock(statement.parent)) {
    return false;
  }
  const siblings = statement.parent.statements;
  const statementIndex = siblings.findIndex((candidate) => candidate === statement);
  if (statementIndex <= 0) {
    return false;
  }
  for (let index = statementIndex - 1; index >= 0; index -= 1) {
    const previous = siblings[index];
    if (!ts.isIfStatement(previous)) {
      continue;
    }
    if (!previous.expression.getText(source).includes("supportsDiagnosticLogSemantics")) {
      continue;
    }
    if (!hasReturnStatement(previous.thenStatement)) {
      continue;
    }
    if (containsExplicitLoggerCall(previous.thenStatement, source, receiver, method)) {
      return true;
    }
  }
  return false;
}

function isInjectedLoggerReceiver(receiver: string): boolean {
  return (
    receiver === "logger" ||
    receiver.endsWith(".logger") ||
    receiver.includes("logger") ||
    receiver.includes("Logger")
  );
}

function isGetLoggerCall(expr: ts.Expression): boolean {
  return (
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    expr.expression.text === "getLogger"
  );
}

function logCallShape(
  node: ts.CallExpression,
): { method: string; receiverExpression: ts.Expression } | undefined {
  if (ts.isPropertyAccessExpression(node.expression)) {
    return {
      method: node.expression.name.text,
      receiverExpression: node.expression.expression,
    };
  }
  if (ts.isElementAccessExpression(node.expression)) {
    return {
      method: stringLiteral(node.expression.argumentExpression) ?? "<dynamic>",
      receiverExpression: node.expression.expression,
    };
  }
  return undefined;
}

function collectOutcomeReasonProblem(
  node: ts.Node,
  source: ts.SourceFile,
  file: string,
  problems: string[],
): void {
  if (!ts.isObjectLiteralExpression(node)) {
    return;
  }
  const eventName = objectLiteralStringProperty(node, "event");
  const outcome = objectLiteralStringProperty(node, "outcome");
  const reason = objectLiteralStringProperty(node, "reason");
  if (eventName && outcome && !DIAGNOSTIC_LOG_OUTCOMES.has(outcome)) {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    problems.push(`${file}:${line}:${eventName}:invalid-outcome:${outcome}`);
  }
  if (eventName && outcome === "success" && reason && NON_SUCCESS_REASON_CODES.has(reason)) {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    problems.push(`${file}:${line}:${eventName}:success+${reason}`);
  } else if (
    eventName &&
    outcome &&
    outcome !== "success" &&
    reason &&
    SUCCESS_REASON_CODES.has(reason)
  ) {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    problems.push(`${file}:${line}:${eventName}:${outcome}+${reason}`);
  } else if (
    eventName &&
    outcome === "success" &&
    eventName.split(".").some((segment) => NON_SUCCESS_REASON_CODES.has(segment))
  ) {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    problems.push(`${file}:${line}:${eventName}:success+event`);
  }
}

function inventoryDiagnosticLogCalls(): DiagnosticLogInventory {
  const known: KnownSubsystemLogCall[] = [];
  const injected: InjectedLoggerCall[] = [];
  const directRoot: DirectRootLoggerCall[] = [];
  const semanticHelpers: SemanticLogHelperCall[] = [];
  const outcomeReasonProblems: string[] = [];
  const injectedExemptionKeyCounts = new Map<string, number>();

  for (const file of PRODUCTION_ROOTS.flatMap((root) => walkTsFiles(root))) {
    const sourceText = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const bindings = new Map<string, string>();

    function collectBindings(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const name = propName(node.name);
        if (name && ts.isCallExpression(node.initializer)) {
          const subsystem = subsystemFromLoggerFactory(node.initializer, bindings, source);
          if (subsystem) {
            bindings.set(name, subsystem);
          }
        }
      }
      ts.forEachChild(node, collectBindings);
    }

    function collectCalls(node: ts.Node): void {
      collectOutcomeReasonProblem(node, source, file, outcomeReasonProblems);
      if (ts.isCallExpression(node)) {
        const helperName =
          expressionName(node.expression, source) ?? node.expression.getText(source);
        const helperEventArgumentIndex = LOG_HELPER_EVENT_ARGUMENT_INDEX.get(helperName);
        if (helperEventArgumentIndex !== undefined) {
          const eventName = stringLiteral(node.arguments[helperEventArgumentIndex]);
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          semanticHelpers.push({
            file,
            line,
            helper: helperName,
            explicitEventNames: eventName ? [eventName] : ["<dynamic>"],
          });
        }
        const shape = logCallShape(node);
        if (shape && (LOG_METHODS.has(shape.method) || isGetLoggerCall(shape.receiverExpression))) {
          const method = shape.method;
          const receiver =
            expressionName(shape.receiverExpression, source) ??
            shape.receiverExpression.getText(source);
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const eventNames = explicitLogEventNames(node, source);
          const explicit = eventNames.length > 0;
          if (isGetLoggerCall(shape.receiverExpression)) {
            directRoot.push({
              file,
              line,
              method,
              hasExplicitEvent: explicit,
              explicitEventNames: eventNames,
            });
            ts.forEachChild(node, collectCalls);
            return;
          }
          if (!LOG_METHODS.has(method)) {
            ts.forEachChild(node, collectCalls);
            return;
          }
          const directSubsystem = ts.isCallExpression(shape.receiverExpression)
            ? subsystemFromLoggerFactory(shape.receiverExpression, bindings, source)
            : undefined;
          const subsystem = bindings.get(receiver) ?? directSubsystem;
          if (subsystem) {
            known.push({
              file,
              line,
              method,
              subsystem,
              hasExplicitEvent: explicit,
              explicitEventNames: eventNames,
            });
          } else if (
            isInjectedLoggerReceiver(receiver) &&
            !isGuardedDiagnosticSemanticsFallbackCall(node, source, receiver, method)
          ) {
            const fingerprint = stableLoggerCallFingerprint(node, source);
            const baseExemptionKey = `${file}:${method}:${receiver}:${fingerprint}`;
            const duplicateIndex = (injectedExemptionKeyCounts.get(baseExemptionKey) ?? 0) + 1;
            injectedExemptionKeyCounts.set(baseExemptionKey, duplicateIndex);
            injected.push({
              file,
              line,
              method,
              receiver,
              exemptionKey: injectedLoggerExemptionKey({
                file,
                method,
                receiver,
                fingerprint,
                duplicateIndex,
              }),
              hasExplicitEvent: explicit,
              explicitEventNames: eventNames,
            });
          }
        }
      }
      ts.forEachChild(node, collectCalls);
    }

    collectBindings(source);
    collectCalls(source);
  }

  return {
    known,
    injected,
    directRoot,
    semanticHelpers,
    outcomeReasonProblems: outcomeReasonProblems.toSorted(),
  };
}

function injectedExemptionCountsByReason(): Record<
  (typeof INJECTED_LOGGER_EXEMPTIONS)[keyof typeof INJECTED_LOGGER_EXEMPTIONS],
  number
> {
  const counts = {
    compat_runtime_adapter: 0,
    operator_output_callback: 0,
  };
  for (const reason of Object.values(INJECTED_LOGGER_EXEMPTIONS)) {
    counts[reason] += 1;
  }
  return counts;
}

function injectedLoggerCallKey(entry: InjectedLoggerCall): string {
  return entry.exemptionKey;
}

function knownSubsystemLogCallKey(entry: KnownSubsystemLogCall): string {
  return `${entry.file}:${entry.line}:${entry.method}:${entry.subsystem}`;
}

function isExtensionPluginFile(file: string): boolean {
  return file.startsWith("extensions/") && !file.startsWith("extensions/diagnostics-otel/");
}

function stableInventoryFingerprint(entries: readonly string[]): string {
  return createHash("sha256").update(entries.toSorted().join("\n")).digest("hex").slice(0, 16);
}

function stableLoggerCallFingerprint(call: ts.CallExpression, source: ts.SourceFile): string {
  const normalizedCallText = call.getText(source).replace(/\s+/gu, " ").trim();
  return createHash("sha256").update(normalizedCallText).digest("hex").slice(0, 12);
}

function injectedLoggerExemptionKey(params: {
  file: string;
  method: string;
  receiver: string;
  fingerprint: string;
  duplicateIndex: number;
}): string {
  const base = `${params.file}:${params.method}:${params.receiver}:${params.fingerprint}`;
  return params.duplicateIndex === 1 ? base : `${base}#${params.duplicateIndex}`;
}

function explicitPlaceholderEventNames(): string[] {
  const placeholders: string[] = [];
  for (const file of PRODUCTION_ROOTS.flatMap((root) => walkTsFiles(root))) {
    const sourceText = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const eventName = objectLiteralStringProperty(node, "event");
        if (eventName?.startsWith("unknown.")) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          placeholders.push(`${file}:${line}:${eventName}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return placeholders;
}

function hasAdjacentDuplicateEventSegment(eventName: string): boolean {
  const segments = eventName.split(".");
  return segments.some((segment, index) => index > 0 && segment === segments[index - 1]);
}

function repeatedEventSegmentSequences(eventName: string): string[] {
  const segments = eventName.split(".");
  const repeated = new Set<string>();
  for (let sequenceLength = 2; sequenceLength <= 3; sequenceLength += 1) {
    for (let start = 0; start + sequenceLength * 2 <= segments.length; start += 1) {
      const sequence = segments.slice(start, start + sequenceLength).join(".");
      for (let next = start + sequenceLength; next + sequenceLength <= segments.length; next += 1) {
        if (sequence === segments.slice(next, next + sequenceLength).join(".")) {
          repeated.add(sequence);
        }
      }
    }
  }
  return [...repeated].toSorted();
}

function hasProseEventNameSequence(eventName: string): boolean {
  const segments = eventName.split(".");
  return PROSE_EVENT_NAME_SEQUENCES.some((sequence) =>
    segments.some((_, index) =>
      sequence.every((segment, offset) => segments[index + offset] === segment),
    ),
  );
}

function explicitEventNamingProblems(
  entries: {
    explicitEventNames: string[];
    file: string;
    line: number;
  }[],
): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    for (const eventName of entry.explicitEventNames) {
      if (eventName.startsWith("<")) {
        continue;
      }
      const reasons: string[] = [];
      if (eventName.length > MAX_EXPLICIT_LOG_EVENT_NAME_LENGTH) {
        reasons.push(`length>${MAX_EXPLICIT_LOG_EVENT_NAME_LENGTH}`);
      }
      if (hasAdjacentDuplicateEventSegment(eventName)) {
        reasons.push("adjacent-duplicate-segment");
      }
      const repeatedSequences = repeatedEventSegmentSequences(eventName);
      if (repeatedSequences.length > 0) {
        reasons.push(`repeated-sequence:${repeatedSequences.join(",")}`);
      }
      if (IMPLEMENTATION_EVENT_NAME_RE.test(eventName)) {
        reasons.push("implementation-name");
      }
      const detailSegments = eventName
        .split(".")
        .filter((segment) => DETAIL_EVENT_NAME_SEGMENTS.has(segment));
      if (detailSegments.length > 0) {
        reasons.push(`detail-segment:${detailSegments.join(",")}`);
      }
      const outcomeSegments = eventName
        .split(".")
        .flatMap((segment) => segment.split("_"))
        .filter((segment) => OUTCOME_EVENT_NAME_SEGMENTS.has(segment));
      if (outcomeSegments.length > 0) {
        reasons.push(`outcome-segment:${outcomeSegments.join(",")}`);
      }
      const proseSegments = eventName
        .split(".")
        .flatMap((segment) => segment.split("_"))
        .filter((segment) => PROSE_EVENT_NAME_SEGMENTS.has(segment));
      if (proseSegments.length > 0) {
        reasons.push(`prose-segment:${proseSegments.join(",")}`);
      }
      if (hasProseEventNameSequence(eventName)) {
        reasons.push("prose-sequence");
      }
      if (reasons.length > 0) {
        problems.push(`${entry.file}:${entry.line}:${eventName}:${reasons.join("+")}`);
      }
    }
  }
  return problems.toSorted();
}

describe("diagnostic OTEL log site inventory", () => {
  it("enumerates current production log-record surfaces", () => {
    const { known, injected, directRoot } = inventoryDiagnosticLogCalls();
    const subsystems = new Set(known.map((entry) => entry.subsystem));
    const explicitEvents = known.filter((entry) => entry.hasExplicitEvent);
    const explicitEventNames = explicitEvents.flatMap((entry) => entry.explicitEventNames);
    const missingOwnedEvents = known.filter(
      (entry) => entry.method !== "raw" && !entry.hasExplicitEvent,
    );
    const coreMissingOwnedEvents = missingOwnedEvents.filter(
      (entry) => !isExtensionPluginFile(entry.file),
    );
    const extensionPluginFreeTextFallbackEvents = missingOwnedEvents.filter((entry) =>
      isExtensionPluginFile(entry.file),
    );
    const injectedMissingEvents = injected.filter((entry) => !entry.hasExplicitEvent);
    const coreInjectedMissingEvents = injectedMissingEvents.filter(
      (entry) => !isExtensionPluginFile(entry.file),
    );
    const extensionInjectedFreeTextFallbackEvents = injectedMissingEvents.filter((entry) =>
      isExtensionPluginFile(entry.file),
    );
    const rootMissingEvents = directRoot.filter((entry) => !entry.hasExplicitEvent);

    expect(known.length).toBeGreaterThanOrEqual(600);
    expect(subsystems.size).toBeGreaterThanOrEqual(100);
    expect(injected.length).toBeGreaterThanOrEqual(200);
    expect(directRoot.length).toBeGreaterThanOrEqual(4);
    expect(explicitEvents.length).toBeGreaterThanOrEqual(620);
    expect(coreMissingOwnedEvents).toEqual([]);
    expect(extensionPluginFreeTextFallbackEvents).toHaveLength(
      EXTENSION_PLUGIN_FREE_TEXT_FALLBACK.knownCount,
    );
    expect(
      stableInventoryFingerprint(
        extensionPluginFreeTextFallbackEvents.map(knownSubsystemLogCallKey),
      ),
    ).toBe(EXTENSION_PLUGIN_FREE_TEXT_FALLBACK.knownFingerprint);
    expect(rootMissingEvents).toEqual([]);
    expect(coreInjectedMissingEvents.map(injectedLoggerCallKey).toSorted()).toEqual(
      Object.keys(INJECTED_LOGGER_EXEMPTIONS).toSorted(),
    );
    expect(extensionInjectedFreeTextFallbackEvents).toHaveLength(
      EXTENSION_PLUGIN_FREE_TEXT_FALLBACK.injectedCount,
    );
    expect(
      stableInventoryFingerprint(
        extensionInjectedFreeTextFallbackEvents.map(injectedLoggerCallKey),
      ),
    ).toBe(EXTENSION_PLUGIN_FREE_TEXT_FALLBACK.injectedFingerprint);
    expect(injectedExemptionCountsByReason()).toEqual({
      compat_runtime_adapter: 4,
      operator_output_callback: 121,
    });
    expect(explicitEventNames).toEqual(
      expect.arrayContaining([
        "heartbeat.delivery",
        "heartbeat.run",
        "heartbeat.runner.agent_run",
        "heartbeat.runner.commitment_run",
        "heartbeat.runner",
        "heartbeat.runner.targeted_run",
        "heartbeat.schedule.delay_clamped",
        "heartbeat.session.archive",
        "heartbeat.wake.deferred",
      ]),
    );

    expect([...subsystems].toSorted()).toEqual(
      expect.arrayContaining([
        "agent/embedded",
        "agents/harness",
        "gateway",
        "gateway/heartbeat",
        "plugins",
        "sessions/store",
        "skills",
        "tasks/registry",
      ]),
    );
  });

  it("rejects placeholder event names in explicit diagnostic semantics", () => {
    expect(explicitPlaceholderEventNames()).toEqual([]);
  });

  it("keeps explicit diagnostic event names concise and structured", () => {
    const { known, injected, directRoot, semanticHelpers, outcomeReasonProblems } =
      inventoryDiagnosticLogCalls();

    expect(
      explicitEventNamingProblems([...known, ...injected, ...directRoot, ...semanticHelpers]),
    ).toEqual([]);
    expect(outcomeReasonProblems).toEqual([]);
  });

  it("keeps the broad OpenClaw logger source census visible", () => {
    const inventory = inventoryBroadDiagnosticLogSources();

    expect(inventory.files).toBeGreaterThanOrEqual(9_000);
    expect(inventory.subsystemLoggerFactories).toBeGreaterThanOrEqual(220);
    expect(inventory.childLoggerFactories).toBeGreaterThanOrEqual(45);
    expect(inventory.injectedLoggerCalls).toBeGreaterThanOrEqual(400);
    expect(inventory.explicitLogEvents).toBeGreaterThanOrEqual(16);
    expect(inventory.trustedSecurityEventEmitters).toBeGreaterThanOrEqual(7);
  });
});
