import { types } from "node:util";
import { isRecord, isStringArray } from "@openclaw/normalization-core/record-coerce";
import { normalizeToolPolicyName } from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { PluginToolRegistration } from "./registry-types.js";
import { normalizePluginToolNames } from "./tool-contracts.js";
import type { OpenClawPluginToolDeclaration } from "./tool-types.js";

const declarationKeys = [
  "name",
  "label",
  "description",
  "parameters",
  "outputSchema",
  "displaySummary",
  "catalogMode",
  "requiredClientCaps",
  "async",
] as const satisfies readonly (keyof OpenClawPluginToolDeclaration)[];

/** Admit a host-owned immutable snapshot without executing accessors or proxy traps. */
function snapshotPassiveData(value: unknown, ancestors = new Set<object>()): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) {
    throw new Error("declarations must contain acyclic plain data without callbacks or proxies");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype) {
    throw new Error("declarations must contain plain objects and arrays");
  }
  ancestors.add(value);
  const copy = Array.isArray(value) ? [] : Object.create(prototype);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) {
      throw new Error("declarations must not contain accessors");
    }
    Object.defineProperty(copy, key, {
      ...descriptor,
      value: snapshotPassiveData(descriptor.value, ancestors),
    });
  }
  ancestors.delete(value);
  return Object.freeze(copy);
}

/** Registration admission; an invalid declaration list rejects the whole registration. */
export function tryAdmitPluginToolDeclarations(
  descriptor: object | undefined,
  registrationNames: string[],
): { declarations?: readonly OpenClawPluginToolDeclaration[]; error?: string } {
  try {
    return { declarations: admitPluginToolDeclarations(descriptor, registrationNames) };
  } catch (error) {
    return { error: `invalid plugin tool declarations: ${String(error)}` };
  }
}

/** Called once on the raw descriptor at registration, before plugin value wrapping. */
export function admitPluginToolDeclarations(
  descriptor: object | undefined,
  registrationNames: string[],
): readonly OpenClawPluginToolDeclaration[] | undefined {
  if (descriptor === undefined || types.isProxy(descriptor)) {
    // Legacy proxy descriptors retain their old behavior; never infer passive metadata from them.
    return undefined;
  }
  const property = Object.getOwnPropertyDescriptor(descriptor, "declarations");
  if (!property) {
    return undefined;
  }
  if (!("value" in property)) {
    throw new Error("declarations must not be an accessor");
  }
  if (property.value === undefined) {
    return undefined;
  }
  const declarations = snapshotPassiveData(property.value);
  if (!Array.isArray(declarations) || declarations.length === 0) {
    throw new Error("declarations must be a non-empty array");
  }
  const names = new Set<string>();
  for (const declaration of declarations) {
    if (
      !isRecord(declaration) ||
      Reflect.ownKeys(declaration).some(
        (key) =>
          !declarationKeys.some((known) => known === key) ||
          !Object.getOwnPropertyDescriptor(declaration, key)?.enumerable,
      ) ||
      typeof declaration.name !== "string" ||
      !declaration.name.trim() ||
      declaration.name !== declaration.name.trim() ||
      typeof declaration.label !== "string" ||
      typeof declaration.description !== "string" ||
      !isRecord(declaration.parameters) ||
      (declaration.outputSchema !== undefined && !isRecord(declaration.outputSchema)) ||
      (declaration.displaySummary !== undefined &&
        typeof declaration.displaySummary !== "string") ||
      (declaration.catalogMode !== undefined && declaration.catalogMode !== "direct-only") ||
      (declaration.requiredClientCaps !== undefined &&
        !isStringArray(declaration.requiredClientCaps)) ||
      (declaration.async !== undefined && declaration.async !== false)
    ) {
      throw new Error("invalid passive tool declaration");
    }
    const name = normalizeToolPolicyName(declaration.name);
    if (names.has(name)) {
      throw new Error(`duplicate passive tool declaration: ${declaration.name}`);
    }
    names.add(name);
  }
  const requested = normalizePluginToolNames(registrationNames);
  const declarationNames = declarations.map((declaration) => declaration.name);
  if (
    requested.length > 0 &&
    (requested.length !== declarationNames.length ||
      requested.some((name) => !declarationNames.includes(name)))
  ) {
    throw new Error("declaration names must match registered tool names");
  }
  registrationNames.push(...declarationNames);
  // SAFETY: Every field and the passive data graph were checked above; schema objects are retained.
  return declarations as readonly OpenClawPluginToolDeclaration[];
}

/** Presentation is static; only this assembly's matching executable can supply callbacks. */
function resolveDeclaredTools(
  declarations: readonly OpenClawPluginToolDeclaration[],
  resolved: AnyAgentTool | AnyAgentTool[] | null | undefined,
): AnyAgentTool[] {
  const executors = new Map<string, AnyAgentTool>();
  const declaredNames = new Set(declarations.map((declaration) => declaration.name));
  for (const tool of resolved ? (Array.isArray(resolved) ? resolved : [resolved]) : []) {
    if (!isRecord(tool) || !declaredNames.has(tool.name) || executors.has(tool.name)) {
      throw new Error("factory returned an undeclared or duplicate tool name");
    }
    if (typeof tool.execute !== "function") {
      throw new Error(`factory tool ${tool.name} is missing execute`);
    }
    executors.set(tool.name, tool);
  }
  return declarations.map((declaration) => {
    const executor = executors.get(declaration.name);
    if (
      executor?.requiredClientCaps !== undefined &&
      (!isStringArray(executor.requiredClientCaps) ||
        executor.requiredClientCaps.some((cap) => !declaration.requiredClientCaps?.includes(cap)))
    ) {
      throw new Error(`factory tool ${declaration.name} requires undeclared client capabilities`);
    }
    const tool: AnyAgentTool = {
      ...declaration,
      async execute(...args) {
        if (!executor) {
          throw new Error(`Tool "${declaration.name}" is unavailable in the current invocation`);
        }
        return executor.execute(...args);
      },
    };
    if (!executor) {
      return tool;
    }
    // Preserve non-enumerable callbacks and their original receiver. Absent declaration
    // fields must not fall through to volatile presentation on the current executor.
    const isPresentation = (key: PropertyKey) => declarationKeys.some((field) => field === key);
    const readExecutorValue = (key: PropertyKey) => {
      const value = Reflect.get(executor, key, executor);
      return typeof value === "function" ? value.bind(executor) : value;
    };
    return new Proxy(tool, {
      get(target, key, receiver) {
        if (Object.hasOwn(target, key) || isPresentation(key)) {
          return Reflect.get(target, key, receiver);
        }
        return readExecutorValue(key);
      },
      has: (target, key) =>
        Reflect.has(target, key) || (!isPresentation(key) && Reflect.has(executor, key)),
      ownKeys: (target) => [
        ...new Set([
          ...Reflect.ownKeys(executor).filter((key) => !isPresentation(key)),
          ...Reflect.ownKeys(target),
        ]),
      ],
      getOwnPropertyDescriptor(target, key) {
        const own = Reflect.getOwnPropertyDescriptor(target, key);
        if (own || isPresentation(key)) {
          return own;
        }
        const source = Reflect.getOwnPropertyDescriptor(executor, key);
        return source
          ? {
              configurable: true,
              enumerable: source.enumerable,
              get: () => readExecutorValue(key),
            }
          : undefined;
      },
    });
  });
}

export function applyPluginToolDeclarations(
  entry: PluginToolRegistration,
  factoryResult: { resolved: AnyAgentTool | AnyAgentTool[] | null | undefined; failed: boolean },
  reportError: (entry: PluginToolRegistration, message: string) => void,
) {
  const { resolved } = factoryResult;
  const declarations = entry.declarations;
  if (!declarations) {
    // A failed undeclared factory contributes nothing; declared presentation survives failure.
    return factoryResult.failed ? undefined : resolved;
  }
  try {
    return resolveDeclaredTools(declarations, resolved);
  } catch (error) {
    reportError(
      entry,
      `plugin tool declarations failed (${entry.pluginId}): ${formatErrorMessage(error)}`,
    );
    // Invalid executors never grant effects; the admitted presentation remains available.
    return resolveDeclaredTools(declarations, null);
  }
}
