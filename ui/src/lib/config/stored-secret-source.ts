import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isSecretRefShape } from "../../../../src/config/redact-snapshot.secret-ref.js";
import type { ConfigSnapshot } from "../../api/types.ts";
import { isEnvPlaceholder, REDACTED_SENTINEL } from "../config-form-utils.ts";
import { resolveEditableSnapshotConfig } from "./config-state-model.ts";

type ConfigPath = ReadonlyArray<string | number>;

/**
 * Where a stored secret comes from, as far as the form can prove it. Only a plain value written in
 * the config file itself can be typed over; every other source, and anything unproven, stays
 * read-only, since a typed value would replace the reference with plaintext in the file.
 */
export type StoredSecretSource =
  | { kind: "literal" }
  | { kind: "environment"; name: string }
  | { kind: "reference" };

const REFERENCE: StoredSecretSource = { kind: "reference" };
const INCLUDE_KEY = "$include";

function containsInclude(value: unknown): boolean {
  const pending = [value];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pending.push(...node);
    } else if (isRecord(node)) {
      if (Object.hasOwn(node, INCLUDE_KEY)) {
        return true;
      }
      pending.push(...Object.values(node));
    }
  }
  return false;
}

/** The value at a path, unless a SecretRef or $include stands somewhere on the way to it. */
function valueAt(root: unknown, path: ConfigPath): { value: unknown } | null {
  let node = root;
  for (const segment of path) {
    if (Array.isArray(node)) {
      if (typeof segment !== "number" || !Object.hasOwn(node, segment)) {
        return null;
      }
      node = node[segment];
    } else if (isRecord(node)) {
      const key = String(segment);
      if (Object.hasOwn(node, INCLUDE_KEY) || isSecretRefShape(node) || !Object.hasOwn(node, key)) {
        return null;
      }
      node = node[key];
    } else {
      return null;
    }
  }
  return { value: node };
}

/** The Gateway's own path spelling, as in its warnings: a.b, list[0], map["dotted.key"]. */
function gatewayPath(path: ConfigPath): string {
  return path.reduce<string>((joined, segment) => {
    if (typeof segment === "number") {
      return `${joined}[${segment}]`;
    }
    if (!/^[A-Za-z_$][A-Za-z0-9_$:-]*$/.test(segment)) {
      return `${joined}[${JSON.stringify(segment)}]`;
    }
    return joined ? `${joined}.${segment}` : segment;
  }, "");
}

function warnedAt(snapshot: ConfigSnapshot, path: ConfigPath): boolean {
  const target = gatewayPath(path);
  return (snapshot.warnings ?? []).some(({ path: warned }) => {
    if (typeof warned !== "string" || warned === "") {
      return false;
    }
    const within = (outer: string, inner: string) =>
      inner === outer || inner.startsWith(`${outer}.`) || inner.startsWith(`${outer}[`);
    return within(warned, target) || within(target, warned);
  });
}

/**
 * Classifies a stored secret, which reaches the form only as the redaction sentinel.
 *
 * The authored file (`parsed`) keeps a whole `${VAR}` as written, which names the variable. A
 * template such as `Bearer ${TOKEN}` is redacted there just like plaintext, so a plain value is
 * proven only when the Gateway also sent the file's text: it withholds `raw` whenever a redacted
 * value isn't written out verbatim, which a template with a set variable never is. A template whose
 * variable is unset keeps its text, and the Gateway warns at that path. Included files are never
 * visible to the form, so a config with any `$include` proves nothing.
 */
export function storedSecretSource(
  snapshot: ConfigSnapshot | null | undefined,
  path: ConfigPath,
): StoredSecretSource {
  if (!snapshot || snapshot.valid === false) {
    return REFERENCE;
  }
  const authored = valueAt(snapshot.parsed, path);
  if (!authored) {
    return REFERENCE;
  }
  if (typeof authored.value === "string" && isEnvPlaceholder(authored.value)) {
    const name = authored.value.trim().slice(2, -1);
    return name ? { kind: "environment", name } : REFERENCE;
  }
  if (
    authored.value !== REDACTED_SENTINEL ||
    typeof snapshot.raw !== "string" ||
    containsInclude(snapshot.parsed) ||
    (snapshot.includedPaths?.length ?? 0) > 0 ||
    warnedAt(snapshot, path)
  ) {
    return REFERENCE;
  }
  const saved = valueAt(resolveEditableSnapshotConfig(snapshot), path);
  return saved?.value === REDACTED_SENTINEL ? { kind: "literal" } : REFERENCE;
}
