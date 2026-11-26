import {
  WRITING_PROFILE_LIMITS,
  type WritingApplicationIdentity,
  type WritingProfile,
  type WritingProfileCatalog,
  type WritingProfilePolicy,
  type WritingProfileSelector,
  type WritingProfileValidation,
} from "./dictation-writing-profile-types.js";

const encoder = new TextEncoder();

class InvalidCatalog extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
  ) {
    super(code);
  }
}

function reject(path: string, code: string): never {
  throw new InvalidCatalog(path, code);
}

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function record(input: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return reject(path, "expected-object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) {
    return reject(path, "expected-object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (
    Reflect.ownKeys(input).length !== keys.length ||
    keys.some((key) => !descriptors[key] || !("value" in descriptors[key]))
  ) {
    return reject(path, "unexpected-or-missing-key");
  }
  return input as Record<string, unknown>;
}

function text(input: unknown, max: number, path: string): string {
  if (
    typeof input !== "string" ||
    input.length > max ||
    !input.trim() ||
    hasControlCharacters(input)
  ) {
    return reject(path, "invalid-text");
  }
  return input;
}

function boolean(input: unknown, path: string): boolean {
  return typeof input === "boolean" ? input : reject(path, "expected-boolean");
}

function choice<T extends string>(input: unknown, values: readonly T[], path: string): T {
  return values.find((value) => value === input) ?? reject(path, "unsupported-value");
}

/** Exact web origins only; URLs carrying user information or document data are invalid. */
export function normalizeWritingOrigin(input: string): string | null {
  if (
    input.length > WRITING_PROFILE_LIMITS.origin ||
    /[\s*@]/u.test(input) ||
    hasControlCharacters(input) ||
    !/^https?:\/\/[^/?#\\]+\/?$/iu.test(input)
  ) {
    return null;
  }
  try {
    const url = new URL(input);
    return url.origin === "null" ||
      !url.hostname ||
      url.hostname.includes("*") ||
      url.username ||
      url.password
      ? null
      : url.origin;
  } catch {
    return null;
  }
}

function application(input: unknown, path: string): WritingApplicationIdentity {
  const value = record(input, ["kind", "id"], path);
  return Object.freeze({
    kind: choice(
      value.kind,
      ["macos-bundle-id", "windows-aumid", "linux-desktop-id"],
      `${path}.kind`,
    ),
    id: text(value.id, WRITING_PROFILE_LIMITS.identifier, `${path}.id`),
  });
}

function selector(input: unknown, path: string): WritingProfileSelector {
  const kind =
    input && typeof input === "object"
      ? Object.getOwnPropertyDescriptor(input, "kind")?.value
      : undefined;
  const value = record(
    input,
    kind === "origin" ? ["kind", "app", "origin"] : ["kind", "app"],
    path,
  );
  const app = application(value.app, `${path}.app`);
  if (value.kind === "application") {
    return Object.freeze({ kind: "application", app });
  }
  if (value.kind !== "origin" || typeof value.origin !== "string") {
    return reject(path, "invalid-selector");
  }
  const origin = normalizeWritingOrigin(value.origin);
  return origin
    ? Object.freeze({ kind: "origin", app, origin })
    : reject(`${path}.origin`, "invalid-origin");
}

function policy(input: unknown, path: string): WritingProfilePolicy {
  const value = record(
    input,
    [
      "handling",
      "locale",
      "punctuation",
      "capitalization",
      "fillers",
      "corrections",
      "structure",
      "register",
    ],
    path,
  );
  let locale: string | null = null;
  if (value.locale !== null) {
    const rawLocale = text(value.locale, 64, `${path}.locale`);
    try {
      locale = Intl.getCanonicalLocales(rawLocale)[0] ?? null;
    } catch {
      return reject(`${path}.locale`, "invalid-locale");
    }
  }
  return Object.freeze({
    handling: choice(value.handling, ["literal", "prose"], `${path}.handling`),
    locale,
    punctuation: choice(value.punctuation, ["preserve", "automatic"], `${path}.punctuation`),
    capitalization: choice(
      value.capitalization,
      ["preserve", "sentence"],
      `${path}.capitalization`,
    ),
    fillers: choice(value.fillers, ["preserve", "conservative"], `${path}.fillers`),
    corrections: choice(value.corrections, ["preserve", "explicit"], `${path}.corrections`),
    structure: choice(value.structure, ["preserve", "paragraphs", "lists"], `${path}.structure`),
    register: choice(value.register, ["unchanged", "chat", "email"], `${path}.register`),
  });
}

/** Stable identity includes platform kind; display labels cannot participate. */
function writingSelectorKey(value: WritingProfileSelector): string {
  return JSON.stringify([
    value.kind,
    value.app.kind,
    value.app.id,
    value.kind === "origin" ? value.origin : null,
  ]);
}

export function createDefaultWritingProfileCatalog(revision = "initial"): WritingProfileCatalog {
  return Object.freeze({
    schemaVersion: 1,
    revision: text(revision, WRITING_PROFILE_LIMITS.revision, "revision"),
    enabled: false,
    defaultProfileId: null,
    profiles: Object.freeze([]),
  });
}

/** Admit untrusted settings once. Returned records are canonical, bounded, and immutable. */
export function validateWritingProfileCatalog(input: unknown): WritingProfileValidation {
  try {
    const version =
      input && typeof input === "object"
        ? Object.getOwnPropertyDescriptor(input, "schemaVersion")?.value
        : undefined;
    if (version !== 1) {
      return {
        ok: false,
        issues: [{ path: "schemaVersion", code: "unsupported-version" }],
        ...(typeof version === "number" && Number.isSafeInteger(version) && version > 1
          ? { futureVersion: version }
          : {}),
      };
    }
    const value = record(
      input,
      ["schemaVersion", "revision", "enabled", "defaultProfileId", "profiles"],
      "catalog",
    );
    const revision = text(value.revision, WRITING_PROFILE_LIMITS.revision, "revision");
    const enabled = boolean(value.enabled, "enabled");
    const defaultProfileId =
      value.defaultProfileId === null
        ? null
        : text(value.defaultProfileId, WRITING_PROFILE_LIMITS.identifier, "defaultProfileId");
    if (!Array.isArray(value.profiles) || value.profiles.length > WRITING_PROFILE_LIMITS.profiles) {
      return reject("profiles", "profile-limit");
    }
    const ids = new Set<string>();
    const rules = new Set<string>();
    let bytes = encoder.encode(
      JSON.stringify({ schemaVersion: 1, revision, enabled, defaultProfileId, profiles: [] }),
    ).length;
    const profiles: WritingProfile[] = [];
    for (let index = 0; index < value.profiles.length; index++) {
      const path = `profiles[${index}]`;
      const entry = record(
        value.profiles[index],
        ["id", "revision", "label", "enabled", "priority", "selectors", "policy"],
        path,
      );
      const id = text(entry.id, WRITING_PROFILE_LIMITS.identifier, `${path}.id`);
      if (ids.has(id)) {
        return reject(`${path}.id`, "duplicate-id");
      }
      ids.add(id);
      if (
        typeof entry.priority !== "number" ||
        !Number.isInteger(entry.priority) ||
        Math.abs(entry.priority) > WRITING_PROFILE_LIMITS.priority
      ) {
        return reject(`${path}.priority`, "invalid-priority");
      }
      if (
        !Array.isArray(entry.selectors) ||
        entry.selectors.length > WRITING_PROFILE_LIMITS.selectors
      ) {
        return reject(`${path}.selectors`, "selector-limit");
      }
      const selectors = entry.selectors.map((item, selectorIndex) =>
        selector(item, `${path}.selectors[${selectorIndex}]`),
      );
      for (const item of selectors) {
        const key = `${entry.priority}:${writingSelectorKey(item)}`;
        if (rules.has(key)) {
          return reject(`${path}.selectors`, "equal-priority-selector-conflict");
        }
        rules.add(key);
      }
      const profile = Object.freeze({
        id,
        revision: text(entry.revision, WRITING_PROFILE_LIMITS.revision, `${path}.revision`),
        label: text(entry.label, WRITING_PROFILE_LIMITS.label, `${path}.label`),
        enabled: boolean(entry.enabled, `${path}.enabled`),
        priority: entry.priority,
        selectors: Object.freeze(selectors),
        policy: policy(entry.policy, `${path}.policy`),
      });
      bytes += encoder.encode(JSON.stringify(profile)).length + (index ? 1 : 0);
      if (bytes > WRITING_PROFILE_LIMITS.catalogBytes) {
        return reject("catalog", "byte-limit");
      }
      profiles.push(profile);
    }
    if (defaultProfileId !== null && !ids.has(defaultProfileId)) {
      return reject("defaultProfileId", "missing-profile");
    }
    return {
      ok: true,
      catalog: Object.freeze({
        schemaVersion: 1,
        revision,
        enabled,
        defaultProfileId,
        profiles: Object.freeze(profiles),
      }),
    };
  } catch (error) {
    if (error instanceof InvalidCatalog) {
      return { ok: false, issues: [{ path: error.path, code: error.code }] };
    }
    return { ok: false, issues: [{ path: "catalog", code: "invalid-data" }] };
  }
}

/** The settings owner retains unknown-version raw bytes for export; this function never activates them. */
export function prepareWritingProfileImport(input: unknown): WritingProfileValidation {
  const result = validateWritingProfileCatalog(input);
  return result.ok
    ? {
        ok: true,
        catalog: Object.freeze({
          ...result.catalog,
          enabled: false,
          profiles: Object.freeze(
            result.catalog.profiles.map((profile) => Object.freeze({ ...profile, enabled: false })),
          ),
        }),
      }
    : result;
}
