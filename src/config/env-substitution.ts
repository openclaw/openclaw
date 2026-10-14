import { isPlainObject } from "../infra/plain-object.js";
import { appendConfigPathSegment } from "../shared/dot-path.js";
import { parseEnvTemplateSecretRef } from "./types.secrets.js";

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

// Bare references and defaults both treat an empty environment value as missing.
const DEFAULT_VALUE_OPERATOR = ":-";

/** Error thrown when a config value references a missing or empty environment variable. */
export class MissingEnvVarError extends Error {
  constructor(
    public readonly varName: string,
    public readonly configPath: string,
  ) {
    super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
    this.name = "MissingEnvVarError";
  }
}

/** One recognized `${VAR}` / `${VAR:-fallback}` placeholder, without its position. */
export type EnvTemplateToken = {
  kind: "escaped" | "substitution";
  name: string;
  /** Authored fallback text, or `undefined` for a bare reference. `""` is a real empty fallback. */
  defaultValue?: string;
};

/** Rebuilds the authored placeholder text for a parsed token. */
function renderEnvTemplateToken(token: EnvTemplateToken): string {
  return token.defaultValue === undefined
    ? `\${${token.name}}`
    : `\${${token.name}${DEFAULT_VALUE_OPERATOR}${token.defaultValue}}`;
}

/** Shares the substitution grammar with write-back preservation, in authoring order. */
export function scanEnvTemplateTokens(value: string): EnvTemplateToken[] {
  return Array.from(iterateEnvTemplateTokens(value), (token) => ({
    kind: token.kind,
    name: token.name,
    defaultValue: token.defaultValue,
  }));
}

function* iterateEnvTemplateTokens(
  value: string,
): Generator<EnvTemplateToken & { start: number; end: number }> {
  for (let index = value.indexOf("$"); index !== -1; index = value.indexOf("$", index + 1)) {
    // Parse escaped placeholders first so "$${VAR}" never resolves from env.
    const escaped = value[index + 1] === "$" && value[index + 2] === "{";
    if (!escaped && value[index + 1] !== "{") {
      continue;
    }
    const start = index + (escaped ? 3 : 2);
    const end = value.indexOf("}", start);
    if (end === -1) {
      continue;
    }
    const body = value.slice(start, end);
    const operatorIndex = body.indexOf(DEFAULT_VALUE_OPERATOR);
    const name = operatorIndex === -1 ? body : body.slice(0, operatorIndex);
    const defaultValue =
      operatorIndex === -1 ? undefined : body.slice(operatorIndex + DEFAULT_VALUE_OPERATOR.length);
    // Nested fallbacks stay literal; their inner references are scanned independently.
    if (
      !ENV_VAR_NAME_PATTERN.test(name) ||
      defaultValue?.includes("$") ||
      defaultValue?.includes("{")
    ) {
      continue;
    }
    yield { kind: escaped ? "escaped" : "substitution", name, defaultValue, start: index, end };
    index = end;
  }
}

/** Missing environment variable warning emitted when substitution is configured to continue. */
export type EnvSubstitutionWarning = {
  varName: string;
  configPath: string;
};

type SubstituteOptions = {
  /** When set, missing vars call this instead of throwing and the original placeholder is preserved. */
  onMissing?: (warning: EnvSubstitutionWarning) => void;
  /** Records exact env SecretRef shorthand that substitution did not materialize. */
  onPendingEnvSecretRef?: (id: string, configPath: string) => void;
  /** Records the source of an exact env SecretRef shorthand that substitution materialized. */
  onResolvedEnvSecretRef?: (id: string, configPath: string) => void;
};

function substituteString(
  value: string,
  env: NodeJS.ProcessEnv,
  configPath: string,
  opts?: SubstituteOptions,
): string {
  if (!value.includes("$")) {
    return value;
  }

  const authoredRef = parseEnvTemplateSecretRef(value);
  if (authoredRef && !containsEnvVarReference(value)) {
    opts?.onPendingEnvSecretRef?.(authoredRef.id, configPath);
  }
  const chunks: string[] = [];
  let end = 0;
  for (const token of iterateEnvTemplateTokens(value)) {
    chunks.push(value.slice(end, token.start));
    end = token.end + 1;
    if (token.kind === "escaped") {
      chunks.push(renderEnvTemplateToken(token));
      continue;
    }
    const envValue = env[token.name];
    if (envValue === undefined || envValue === "") {
      if (token.defaultValue !== undefined) {
        // An authored fallback resolves the reference without a missing or pending signal.
        chunks.push(token.defaultValue);
        continue;
      }
      if (opts?.onMissing) {
        opts.onMissing({ varName: token.name, configPath });
        if (authoredRef?.id === token.name) {
          opts.onPendingEnvSecretRef?.(token.name, configPath);
        }
        // Preserve the original placeholder so the value is visibly unresolved.
        chunks.push(renderEnvTemplateToken(token));
        continue;
      }
      throw new MissingEnvVarError(token.name, configPath);
    }
    if (authoredRef?.id === token.name) {
      opts?.onResolvedEnvSecretRef?.(token.name, configPath);
    }
    chunks.push(envValue);
  }
  chunks.push(value.slice(end));

  return chunks.join("");
}

/** Detects unescaped `${VAR}` references without treating escaped `$${VAR}` as references. */
export function containsEnvVarReference(value: string): boolean {
  for (const token of iterateEnvTemplateTokens(value)) {
    if (token.kind === "substitution") {
      return true;
    }
  }
  return false;
}

/** Resolve config string templates, preserving unresolved text when onMissing is supplied. */
export function resolveConfigEnvVars(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  opts?: SubstituteOptions,
): unknown {
  // Resume one parent at a time so callbacks retain recursive depth-first order
  // without consuming the engine stack for deeply nested replacement values.
  const pending: Array<() => boolean> = [];
  const visit = (current: unknown, currentPath: string): unknown => {
    if (typeof current === "string") {
      return substituteString(current, env, currentPath, opts);
    }
    if (Array.isArray(current)) {
      const length = current.length;
      const result: unknown[] = [];
      result.length = length;
      let index = 0;
      pending.push(() => {
        while (index < length) {
          const key = index++;
          if (key in current) {
            result[key] = visit(current[key], `${currentPath}[${key}]`);
            return true;
          }
        }
        return false;
      });
      return result;
    }
    if (isPlainObject(current)) {
      const result: Record<string, unknown> = {};
      const entries = Object.entries(current)[Symbol.iterator]();
      pending.push(() => {
        const entry = entries.next();
        if (entry.done) {
          return false;
        }
        const [key, child] = entry.value;
        result[key] = visit(child, appendConfigPathSegment(currentPath, key));
        return true;
      });
      return result;
    }
    return current;
  };
  const result = visit(value, "");
  for (let next = pending.at(-1); next; next = pending.at(-1)) {
    if (!next()) {
      pending.pop();
    }
  }
  return result;
}
