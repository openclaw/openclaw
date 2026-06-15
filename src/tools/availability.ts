// Evaluates tool descriptors against runtime availability constraints.
import type {
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ToolAvailabilityContext,
  ToolAvailabilityDiagnostic,
  ToolAvailabilityExpression,
  ToolAvailabilitySignal,
  ToolDescriptor,
} from "./types.js";

/**
 * Tool availability evaluator for descriptor-driven tool planning.
 *
 * Descriptors express why a tool can be shown as small signals; this module
 * turns those signals into diagnostics without knowing any concrete tool owner.
 */
function isRecord(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveConfigPath(
  config: JsonObject | undefined,
  path: readonly string[],
): JsonValue | undefined {
  let current: JsonValue | undefined = config;
  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function hasConfiguredValue(params: {
  value: JsonValue | undefined;
  signal: Extract<ToolAvailabilitySignal, { readonly kind: "config" }>;
  context: ToolAvailabilityContext;
}): boolean {
  const { value, signal } = params;
  if (value === undefined || value === null) {
    return false;
  }
  if ((signal.check ?? "exists") === "available") {
    // "available" delegates semantic checks, for example provider auth that is configured but stale.
    return (
      params.context.isConfigValueAvailable?.({
        value,
        path: signal.path,
        signal,
      }) === true
    );
  }
  if ((signal.check ?? "exists") === "exists") {
    return true;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function isValidSignalShape(obj: Record<string, unknown>): boolean {
  const kind = obj.kind;
  switch (kind) {
    case "always":
      return true;
    case "auth":
      return typeof obj.providerId === "string";
    case "config":
      return Array.isArray(obj.path);
    case "env":
      return typeof obj.name === "string";
    case "plugin-enabled":
      return typeof obj.pluginId === "string";
    case "context":
      return typeof obj.key === "string";
    default:
      return false;
  }
}

function hasAvailabilityExpressionShape(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if ("kind" in obj) {
    return isValidSignalShape(obj);
  }
  if ("allOf" in obj) {
    const allOf = obj.allOf;
    if (!Array.isArray(allOf)) {
      return false;
    }
    return allOf.every((entry) => hasAvailabilityExpressionShape(entry));
  }
  if ("anyOf" in obj) {
    const anyOf = obj.anyOf;
    if (!Array.isArray(anyOf)) {
      return false;
    }
    return anyOf.every((entry) => hasAvailabilityExpressionShape(entry));
  }
  return false;
}

/** Narrow unknown values to planner availability expressions before descriptor capture. */
export function isToolAvailabilityExpression(value: unknown): value is ToolAvailabilityExpression {
  return hasAvailabilityExpressionShape(value);
}

function diagnostic(
  reason: ToolAvailabilityDiagnostic["reason"],
  signal: ToolAvailabilitySignal,
  message: string,
): ToolAvailabilityDiagnostic {
  return { reason, signal, message };
}

function evaluateSignal(
  signal: ToolAvailabilitySignal,
  context: ToolAvailabilityContext,
): ToolAvailabilityDiagnostic | null {
  switch (signal.kind) {
    case "always":
      return null;
    case "auth":
      if (!signal.providerId) {
        return diagnostic(
          "unsupported-signal",
          signal,
          "Malformed auth signal: missing providerId",
        );
      }
      return context.authProviderIds?.has(signal.providerId)
        ? null
        : diagnostic("auth-missing", signal, `Missing auth provider: ${signal.providerId}`);
    case "config": {
      if (!Array.isArray(signal.path)) {
        return diagnostic("unsupported-signal", signal, "Malformed config signal: missing path");
      }
      const value = resolveConfigPath(context.config, signal.path);
      return hasConfiguredValue({ value, signal, context })
        ? null
        : diagnostic("config-missing", signal, `Missing config path: ${signal.path.join(".")}`);
    }
    case "env":
      if (!signal.name) {
        return diagnostic("unsupported-signal", signal, "Malformed env signal: missing name");
      }
      return context.env?.[signal.name]?.trim()
        ? null
        : diagnostic("env-missing", signal, `Missing environment value: ${signal.name}`);
    case "plugin-enabled":
      if (!signal.pluginId) {
        return diagnostic(
          "unsupported-signal",
          signal,
          "Malformed plugin-enabled signal: missing pluginId",
        );
      }
      return context.enabledPluginIds?.has(signal.pluginId)
        ? null
        : diagnostic("plugin-disabled", signal, `Plugin is not enabled: ${signal.pluginId}`);
    case "context": {
      if (!signal.key) {
        return diagnostic("unsupported-signal", signal, "Malformed context signal: missing key");
      }
      const value: JsonPrimitive | undefined = context.values?.[signal.key];
      if (!("equals" in signal)) {
        return value === undefined
          ? diagnostic("context-mismatch", signal, `Missing context value: ${signal.key}`)
          : null;
      }
      return value === signal.equals
        ? null
        : diagnostic("context-mismatch", signal, `Context value did not match: ${signal.key}`);
    }
    default:
      return diagnostic("unsupported-signal", signal, "Unsupported availability signal");
  }
}

function evaluateExpression(
  expression: ToolAvailabilityExpression,
  context: ToolAvailabilityContext,
): readonly ToolAvailabilityDiagnostic[] {
  if ("kind" in expression) {
    const diagnosticLocal = evaluateSignal(expression, context);
    return diagnosticLocal ? [diagnosticLocal] : [];
  }
  if ("allOf" in expression) {
    if (!Array.isArray(expression.allOf) || expression.allOf.length === 0) {
      return [
        {
          reason: "unsupported-signal",
          message: "Empty availability allOf group",
        },
      ];
    }
    return expression.allOf.flatMap((entry) => evaluateExpression(entry, context));
  }
  if ("anyOf" in expression) {
    if (!Array.isArray(expression.anyOf) || expression.anyOf.length === 0) {
      return [
        {
          reason: "unsupported-signal",
          message: "Empty availability anyOf group",
        },
      ];
    }
    const diagnostics = expression.anyOf.map((entry) => evaluateExpression(entry, context));
    // "unsupported-signal" marks a malformed descriptor, not a runtime condition, so it must surface
    // even when a sibling branch is available; otherwise an available branch masks an authoring error.
    const unsupported = diagnostics.flat().filter((entry) => entry.reason === "unsupported-signal");
    if (diagnostics.some((entries) => entries.length === 0)) {
      return unsupported;
    }
    return diagnostics.flat();
  }
  return [
    {
      reason: "unsupported-signal",
      message: "Unsupported availability expression",
    },
  ];
}

/** Evaluate one descriptor against runtime context and return hidden-tool diagnostics. */
export function evaluateToolAvailability(params: {
  descriptor: ToolDescriptor;
  context?: ToolAvailabilityContext;
}): readonly ToolAvailabilityDiagnostic[] {
  const context = params.context ?? {};
  const availability = params.descriptor.availability ?? { kind: "always" };
  if (!hasAvailabilityExpressionShape(availability)) {
    return [
      {
        reason: "unsupported-signal",
        message: "Unsupported availability expression",
      },
    ];
  }
  return evaluateExpression(availability, context);
}
