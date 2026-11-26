/** Static, account-owned dictation definitions. No body is parsed as a template. */
export const VOICE_SNIPPETS_PREFERENCE_KEY = "dictation.snippets";
export const VOICE_SNIPPET_BODY_BYTES = 16 * 1024;
export const VOICE_SNIPPET_CAPTURE_BYTES = 64 * 1024;
export const VOICE_SNIPPET_COUNT = 500;
export const VOICE_SNIPPET_CATALOG_BYTES = 9 * 1024 * 1024;

export type VoiceSnippet = {
  schemaVersion: 1;
  id: string;
  revision: number;
  name: string;
  locale: string;
  triggers: string[];
  body: string;
  enabled: boolean;
  sensitivity: "normal" | "sensitive";
};

export type VoiceSnippetCatalog = {
  schemaVersion: 1;
  revision: number;
  enabled: boolean;
  snippets: VoiceSnippet[];
};

export type VoiceSnippetEdit =
  | {
      type: "save";
      snippet: Omit<VoiceSnippet, "schemaVersion" | "revision">;
      expectedRevision: number | null;
    }
  | { type: "delete"; id: string; expectedRevision: number }
  | { type: "enabled"; enabled: boolean }
  | { type: "import"; data: string };

export type VoiceSnippetValidationCode =
  | "invalid-schema"
  | "invalid-record"
  | "invalid-locale"
  | "invalid-trigger"
  | "invalid-encoding"
  | "body-too-large"
  | "catalog-too-large"
  | "too-many-snippets"
  | "duplicate-id"
  | "trigger-collision"
  | "conflict";

const messages: Record<VoiceSnippetValidationCode, string> = {
  "invalid-schema":
    "Use the version 1 static-snippet format. Dynamic template features are unsupported.",
  "invalid-record":
    "Each snippet needs a stable ID, revision, name, body, enabled state, and sensitivity.",
  "invalid-locale": "Choose a valid language tag, such as en-US.",
  "invalid-trigger": "Use one to eight nonempty trigger names of at most 256 characters.",
  "invalid-encoding": "Snippet text must contain valid Unicode characters.",
  "body-too-large": "A snippet body must fit within 16 KiB of UTF-8 text.",
  "catalog-too-large": "The snippet catalog or import must fit within 9 MiB of JSON.",
  "too-many-snippets": "Keep at most 500 snippets, including disabled definitions.",
  "duplicate-id": "Each snippet must have a distinct stable ID.",
  "trigger-collision":
    "Enabled snippets share a trigger. Rename a trigger or disable a conflicting snippet.",
  conflict: "Snippets changed since this view was loaded. Refresh before saving.",
};

/** Content-free errors are safe to present or log; IDs identify at most ten collisions. */
export class VoiceSnippetValidationError extends Error {
  constructor(
    readonly code: VoiceSnippetValidationCode,
    readonly ids: readonly string[] = [],
  ) {
    super(messages[code]);
    this.name = "VoiceSnippetValidationError";
  }
}

export function createVoiceSnippetCatalog(): VoiceSnippetCatalog {
  return { schemaVersion: 1, revision: 0, enabled: false, snippets: [] };
}

export function voiceSnippetUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function revision(value: unknown, minimum = 1): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function wellFormed(value: string) {
  for (const char of value) {
    const point = char.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) {
      throw new VoiceSnippetValidationError("invalid-encoding");
    }
  }
}

export function normalizeVoiceSnippetTrigger(trigger: string, locale: string): string {
  return trigger.normalize("NFC").trim().replace(/\s+/gu, " ").toLocaleLowerCase(locale);
}

function validateSnippet(value: unknown): asserts value is VoiceSnippet {
  if (
    !record(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "id",
      "revision",
      "name",
      "locale",
      "triggers",
      "body",
      "enabled",
      "sensitivity",
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(value.id) ||
    !revision(value.revision) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 256 ||
    typeof value.body !== "string" ||
    !value.body.length ||
    typeof value.enabled !== "boolean" ||
    (value.sensitivity !== "normal" && value.sensitivity !== "sensitive")
  ) {
    throw new VoiceSnippetValidationError("invalid-record");
  }
  if (typeof value.locale !== "string" || value.locale.length > 64 || !value.locale) {
    throw new VoiceSnippetValidationError("invalid-locale");
  }
  try {
    Intl.getCanonicalLocales(value.locale);
  } catch {
    throw new VoiceSnippetValidationError("invalid-locale");
  }
  if (!Array.isArray(value.triggers) || !value.triggers.length || value.triggers.length > 8) {
    throw new VoiceSnippetValidationError("invalid-trigger");
  }
  const seen = new Set<string>();
  for (const trigger of value.triggers) {
    if (typeof trigger !== "string" || !trigger.trim() || trigger.length > 256) {
      throw new VoiceSnippetValidationError("invalid-trigger");
    }
    wellFormed(trigger);
    const key = normalizeVoiceSnippetTrigger(trigger, value.locale);
    if (seen.has(key)) {
      throw new VoiceSnippetValidationError("trigger-collision", [value.id]);
    }
    seen.add(key);
  }
  wellFormed(value.name);
  wellFormed(value.body);
  if (voiceSnippetUtf8Bytes(value.body) > VOICE_SNIPPET_BODY_BYTES) {
    throw new VoiceSnippetValidationError("body-too-large");
  }
}

/** Validates the entire replacement before any persistent state changes. */
export function validateVoiceSnippetCatalog(value: unknown): VoiceSnippetCatalog {
  if (
    !record(value) ||
    !exactKeys(value, ["schemaVersion", "revision", "enabled", "snippets"]) ||
    value.schemaVersion !== 1 ||
    !revision(value.revision, 0) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.snippets)
  ) {
    throw new VoiceSnippetValidationError("invalid-schema");
  }
  if (value.snippets.length > VOICE_SNIPPET_COUNT) {
    throw new VoiceSnippetValidationError("too-many-snippets");
  }
  const ids = new Set<string>();
  const triggers = new Map<string, string>();
  for (const snippet of value.snippets) {
    validateSnippet(snippet);
    if (ids.has(snippet.id)) {
      throw new VoiceSnippetValidationError("duplicate-id");
    }
    ids.add(snippet.id);
    if (snippet.enabled) {
      for (const trigger of snippet.triggers) {
        const key = `${Intl.getCanonicalLocales(snippet.locale)[0]}\0${normalizeVoiceSnippetTrigger(trigger, snippet.locale)}`;
        const previous = triggers.get(key);
        if (previous) {
          throw new VoiceSnippetValidationError("trigger-collision", [previous, snippet.id]);
        }
        triggers.set(key, snippet.id);
      }
    }
  }
  if (voiceSnippetUtf8Bytes(JSON.stringify(value)) > VOICE_SNIPPET_CATALOG_BYTES) {
    throw new VoiceSnippetValidationError("catalog-too-large");
  }
  return value as VoiceSnippetCatalog;
}

function sameDefinition(first: VoiceSnippet, second: VoiceSnippet): boolean {
  return (
    first.id === second.id &&
    first.name === second.name &&
    first.locale === second.locale &&
    first.body === second.body &&
    first.enabled === second.enabled &&
    first.sensitivity === second.sensitivity &&
    first.triggers.length === second.triggers.length &&
    first.triggers.every((trigger, i) => trigger === second.triggers[i])
  );
}

/** Compare-and-swap is enforced again by the existing profile worker in its transaction. */
export function assertVoiceSnippetCatalogTransition(
  previous: VoiceSnippetCatalog,
  next: VoiceSnippetCatalog,
): void {
  if (next.revision !== previous.revision + 1) {
    throw new VoiceSnippetValidationError("conflict");
  }
  const prior = new Map(previous.snippets.map((snippet) => [snippet.id, snippet]));
  for (const snippet of next.snippets) {
    const old = prior.get(snippet.id);
    if (old && snippet.revision !== old.revision + Number(!sameDefinition(old, snippet))) {
      throw new VoiceSnippetValidationError("conflict");
    }
  }
}

export function editVoiceSnippetCatalog(
  catalog: VoiceSnippetCatalog,
  edit: VoiceSnippetEdit,
): VoiceSnippetCatalog {
  let snippets = catalog.snippets;
  let enabled = catalog.enabled;
  if (edit.type === "enabled") {
    enabled = edit.enabled;
  } else if (edit.type === "import") {
    if (voiceSnippetUtf8Bytes(edit.data) > VOICE_SNIPPET_CATALOG_BYTES) {
      throw new VoiceSnippetValidationError("catalog-too-large");
    }
    let imported: unknown;
    try {
      imported = JSON.parse(edit.data);
    } catch {
      throw new VoiceSnippetValidationError("invalid-schema");
    }
    if (
      !record(imported) ||
      !exactKeys(imported, ["schemaVersion", "snippets"]) ||
      imported.schemaVersion !== 1
    ) {
      throw new VoiceSnippetValidationError("invalid-schema");
    }
    const valid = validateVoiceSnippetCatalog({ ...imported, revision: 0, enabled: false });
    const current = new Map(catalog.snippets.map((snippet) => [snippet.id, snippet]));
    snippets = valid.snippets.map((snippet) => {
      const previous = current.get(snippet.id);
      return previous
        ? { ...snippet, revision: previous.revision + Number(!sameDefinition(previous, snippet)) }
        : snippet;
    });
  } else {
    const id = edit.type === "save" ? edit.snippet.id : edit.id;
    const previous = snippets.find((snippet) => snippet.id === id);
    if ((previous?.revision ?? null) !== edit.expectedRevision) {
      throw new VoiceSnippetValidationError("conflict");
    }
    if (edit.type === "delete") {
      snippets = snippets.filter((snippet) => snippet.id !== id);
    } else {
      const candidate: VoiceSnippet = {
        ...edit.snippet,
        schemaVersion: 1,
        revision: previous?.revision ?? 1,
      };
      if (previous && !sameDefinition(previous, candidate)) {
        candidate.revision += 1;
      }
      snippets = previous
        ? snippets.map((snippet) => (snippet.id === id ? candidate : snippet))
        : [...snippets, candidate];
    }
  }
  return validateVoiceSnippetCatalog({
    schemaVersion: 1,
    revision: catalog.revision + 1,
    enabled,
    snippets,
  });
}

export function exportVoiceSnippetCatalog(catalog: VoiceSnippetCatalog): string {
  return JSON.stringify({ schemaVersion: 1, snippets: catalog.snippets });
}

export function searchVoiceSnippets(catalog: VoiceSnippetCatalog, query: string): VoiceSnippet[] {
  const term = query.normalize("NFC").trim().toLocaleLowerCase();
  return catalog.snippets.filter(
    (snippet) =>
      !term ||
      [snippet.name, ...snippet.triggers].some((value) =>
        value.normalize("NFC").toLocaleLowerCase().includes(term),
      ),
  );
}
