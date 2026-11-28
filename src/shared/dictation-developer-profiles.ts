import { builtinDeveloperProfiles } from "./dictation-developer-builtins.ts";
import {
  DEVELOPER_LIMITS,
  type DeveloperAlternative,
  type DeveloperGrammar,
  type DeveloperLanguage,
  type DeveloperProfile,
  type DeveloperSymbol,
} from "./dictation-developer-types.ts";

const encoder = new TextEncoder();
const grammarKeys = [
  "codeStart",
  "codeEnd",
  "literalStart",
  "literalEnd",
  "spellStart",
  "spellEnd",
  "identifierEnd",
  "symbolStart",
  "symbolEnd",
  "snakeCase",
  "camelCase",
  "pascalCase",
  "kebabCase",
] as const;
const profileKeys = [
  "schemaVersion",
  "id",
  "revision",
  "name",
  "language",
  "languageVersion",
  "locale",
  "grammar",
  "spelling",
  "symbols",
  "acronymPolicy",
  "quoteStyle",
  "whitespace",
];
const legacyKeys = profileKeys.filter(
  (key) => !["revision", "languageVersion", "grammar", "spelling"].includes(key),
);

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a profile object.");
  }
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) {
    throw new Error("Unknown profile fields are not supported.");
  }
  return result;
}

function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!value && !allowEmpty) || encoder.encode(value).length > max) {
    throw new Error("A profile string is missing or exceeds its bound.");
  }
  // Unpaired surrogates cannot round-trip through UTF-8 export unchanged.
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("Profile strings must contain valid Unicode.");
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error("Profile strings must contain valid Unicode.");
    }
  }
  return value;
}

function phrase(value: unknown): string {
  const result = text(value, 96);
  if (!/^[a-z]+(?: [a-z]+){0,7}$/u.test(result)) {
    throw new Error("Command labels must be lowercase English words separated by single spaces.");
  }
  return result;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Whitespace policies must be booleans.");
  }
  return value;
}

function grammar(value: unknown): Readonly<DeveloperGrammar> {
  const input = record(value, grammarKeys);
  return Object.freeze({
    codeStart: phrase(input.codeStart),
    codeEnd: phrase(input.codeEnd),
    literalStart: phrase(input.literalStart),
    literalEnd: phrase(input.literalEnd),
    spellStart: phrase(input.spellStart),
    spellEnd: phrase(input.spellEnd),
    identifierEnd: phrase(input.identifierEnd),
    symbolStart: phrase(input.symbolStart),
    symbolEnd: phrase(input.symbolEnd),
    snakeCase: phrase(input.snakeCase),
    camelCase: phrase(input.camelCase),
    pascalCase: phrase(input.pascalCase),
    kebabCase: phrase(input.kebabCase),
  });
}

function alternatives(value: unknown): readonly DeveloperAlternative[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    throw new Error("Ambiguous symbols need two to eight alternatives.");
  }
  const results = value.map((item) => {
    const entry = record(item, ["label", "text"]);
    return Object.freeze({ label: text(entry.label, 96), text: text(entry.text, 128) });
  });
  if (new Set(results.map((item) => item.text)).size !== results.length) {
    throw new Error("Symbol alternatives must be distinct.");
  }
  return Object.freeze(results);
}

function symbols(value: unknown): readonly DeveloperSymbol[] {
  if (!Array.isArray(value) || value.length > DEVELOPER_LIMITS.symbols) {
    throw new Error("A profile may contain at most 256 symbol mappings.");
  }
  return Object.freeze(
    value.map((item) => {
      const input = record(item, ["spoken", "text", "alternatives"]);
      const options = alternatives(input.alternatives);
      const replacement = text(input.text, 128);
      if (options && !options.some((option) => option.text === replacement)) {
        throw new Error("The symbol text must be one of its advertised alternatives.");
      }
      return Object.freeze({
        spoken: phrase(input.spoken),
        text: replacement,
        ...(options ? { alternatives: options } : {}),
      });
    }),
  );
}

function validateLabels(profile: DeveloperProfile): void {
  const labels = [...Object.values(profile.grammar), ...profile.symbols.map((item) => item.spoken)];
  for (let first = 0; first < labels.length; first++) {
    for (let second = first + 1; second < labels.length; second++) {
      if (
        labels[first] === labels[second] ||
        labels[first]!.startsWith(`${labels[second]} `) ||
        labels[second]!.startsWith(`${labels[first]} `)
      ) {
        throw new Error("Command definitions must not duplicate or overlap one another.");
      }
    }
  }
  // Replacements are never interpreted recursively. Reject cyclic declarations
  // as malformed import intent as well, rather than guessing alias semantics.
  const edges = new Map(profile.symbols.map((item) => [item.spoken, item.text]));
  for (const label of edges.keys()) {
    const seen = new Set<string>();
    let cursor: string | undefined = label;
    while (cursor !== undefined && edges.has(cursor)) {
      if (seen.has(cursor)) {
        throw new Error("Cyclic symbol mappings are not supported.");
      }
      seen.add(cursor);
      cursor = edges.get(cursor);
    }
  }
}

export type DeveloperProfileImport =
  | { ok: true; profile: DeveloperProfile; migrated: boolean }
  | { ok: false; error: string };

/** The only import boundary; authored mappings are inert text, never expressions. */
export function parseDeveloperProfile(json: string): DeveloperProfileImport {
  try {
    if (
      json.length > DEVELOPER_LIMITS.profileBytes ||
      encoder.encode(json).length > DEVELOPER_LIMITS.profileBytes
    ) {
      throw new Error("A profile may contain at most 64 KiB.");
    }
    let input = record(JSON.parse(json), profileKeys);
    const migrated = input.schemaVersion === 0;
    if (migrated) {
      input = record(input, legacyKeys);
      const defaults = builtinDeveloperProfiles[0]!;
      input = {
        ...input,
        schemaVersion: 1,
        revision: 1,
        languageVersion: "fragments-v1",
        grammar: defaults.grammar,
        spelling: defaults.spelling,
      };
    }
    if (input.schemaVersion !== 1) {
      throw new Error("Unsupported profile version; keep or export the existing profile.");
    }
    const id = text(input.id, 64);
    if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
      throw new Error("Profile IDs must use lowercase letters, digits, and hyphens.");
    }
    if (
      !Number.isSafeInteger(input.revision) ||
      typeof input.revision !== "number" ||
      input.revision < 1
    ) {
      throw new Error("Profile revision must be a positive safe integer.");
    }
    const language = input.language;
    if (
      language !== "plain-code" &&
      language !== "json" &&
      language !== "typescript" &&
      language !== "python"
    ) {
      throw new Error("Unsupported language; select a supported profile or Prose explicitly.");
    }
    if (input.locale !== "en-US" || input.languageVersion !== "fragments-v1") {
      throw new Error("Only explicitly selected en-US fragment profiles are supported.");
    }
    if (input.acronymPolicy !== "word" && input.acronymPolicy !== "preserve") {
      throw new Error("Choose an explicit acronym policy.");
    }
    if (input.quoteStyle !== "single" && input.quoteStyle !== "double") {
      throw new Error("Choose straight single or double quotes.");
    }
    const spelling = record(input.spelling, ["capital", "lower", "digit", "digits"]);
    if (!Array.isArray(spelling.digits) || spelling.digits.length !== 10) {
      throw new Error("Spelling requires exactly ten digit labels in order.");
    }
    const digitLabels = spelling.digits.map(phrase);
    const spellingLabels = [
      phrase(spelling.capital),
      phrase(spelling.lower),
      phrase(spelling.digit),
    ];
    if (
      new Set(digitLabels).size !== 10 ||
      new Set([...spellingLabels, ...digitLabels]).size !== 13 ||
      spellingLabels.some((label) => label.includes(" ")) ||
      digitLabels.some((label) => label.includes(" "))
    ) {
      throw new Error("Spelling labels must be distinct single words.");
    }
    const whitespace = record(input.whitespace, [
      "commaSpace",
      "colonSpace",
      "operatorSpace",
      "indentation",
    ]);
    if (
      whitespace.indentation !== "\t" &&
      whitespace.indentation !== "  " &&
      whitespace.indentation !== "    "
    ) {
      throw new Error("Indentation must be a tab, two spaces, or four spaces.");
    }
    const profile: DeveloperProfile = Object.freeze({
      schemaVersion: 1,
      id,
      revision: input.revision,
      name: text(input.name, 96),
      language: language satisfies DeveloperLanguage,
      languageVersion: "fragments-v1",
      locale: "en-US",
      grammar: grammar(input.grammar),
      spelling: Object.freeze({
        capital: spellingLabels[0]!,
        lower: spellingLabels[1]!,
        digit: spellingLabels[2]!,
        digits: Object.freeze(digitLabels),
      }),
      symbols: symbols(input.symbols),
      acronymPolicy: input.acronymPolicy,
      quoteStyle: input.quoteStyle,
      whitespace: Object.freeze({
        commaSpace: boolean(whitespace.commaSpace),
        colonSpace: boolean(whitespace.colonSpace),
        operatorSpace: boolean(whitespace.operatorSpace),
        indentation: whitespace.indentation,
      }),
    });
    validateLabels(profile);
    if (encoder.encode(JSON.stringify(profile)).length > DEVELOPER_LIMITS.profileBytes) {
      throw new Error("The migrated profile exceeds the 64 KiB export bound.");
    }
    return { ok: true, profile, migrated };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof SyntaxError
          ? "Profile JSON is invalid."
          : error instanceof Error
            ? error.message
            : "Profile import failed.",
    };
  }
}

/** In-memory authored profile owner. Callers persist only after a successful import. */
export class DeveloperProfileRegistry {
  private readonly values: Map<string, DeveloperProfile>;

  constructor(initial: readonly DeveloperProfile[] = builtinDeveloperProfiles) {
    this.values = new Map(initial.map((profile) => [profile.id, profile]));
  }

  get profiles(): readonly DeveloperProfile[] {
    return Object.freeze([...this.values.values()]);
  }

  get(id: string): DeveloperProfile | undefined {
    return this.values.get(id);
  }

  import(json: string, expectedRevision?: number): DeveloperProfileImport {
    const result = parseDeveloperProfile(json);
    if (!result.ok) {
      return result;
    }
    const prior = this.values.get(result.profile.id);
    if (
      prior &&
      (expectedRevision !== prior.revision || result.profile.revision <= prior.revision)
    ) {
      return {
        ok: false,
        error:
          "Profile changed or the import is a downgrade; export the current profile before replacing it.",
      };
    }
    if (!prior && expectedRevision !== undefined) {
      return { ok: false, error: "The expected profile is no longer present." };
    }
    this.values.set(result.profile.id, result.profile);
    return result;
  }

  export(id: string): string {
    const profile = this.values.get(id);
    if (!profile) {
      throw new Error("Profile is unavailable.");
    }
    return JSON.stringify(profile);
  }
}
