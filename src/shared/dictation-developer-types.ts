/** The grammar consumes recognized text, not acoustic tokens or executable code. */
export type DeveloperMode = "prose" | "literal" | "developer";
export type DeveloperLanguage = "plain-code" | "json" | "typescript" | "python";
export type DeveloperAlternative = { label: string; text: string };
export type DeveloperSymbol = {
  spoken: string;
  text: string;
  alternatives?: readonly DeveloperAlternative[];
};
export type DeveloperGrammar = {
  codeStart: string;
  codeEnd: string;
  literalStart: string;
  literalEnd: string;
  spellStart: string;
  spellEnd: string;
  identifierEnd: string;
  symbolStart: string;
  symbolEnd: string;
  snakeCase: string;
  camelCase: string;
  pascalCase: string;
  kebabCase: string;
};
export type DeveloperProfile = {
  schemaVersion: 1;
  id: string;
  revision: number;
  name: string;
  language: DeveloperLanguage;
  languageVersion: "fragments-v1";
  locale: "en-US";
  grammar: Readonly<DeveloperGrammar>;
  spelling: Readonly<{
    capital: string;
    lower: string;
    digit: string;
    digits: readonly string[];
  }>;
  symbols: readonly DeveloperSymbol[];
  acronymPolicy: "word" | "preserve";
  quoteStyle: "single" | "double";
  whitespace: Readonly<{
    commaSpace: boolean;
    colonSpace: boolean;
    operatorSpace: boolean;
    indentation: "\t" | "  " | "    ";
  }>;
};
export type DeveloperRange = { start: number; end: number };
export type DeveloperEdit = DeveloperRange & {
  intentId: string;
  source: string;
  text: string;
};
export type DeveloperDiagnostic = DeveloperRange & {
  id: string;
  code: "incomplete" | "ambiguous" | "syntax" | "unsupported" | "invalid" | "limit";
  severity: "blocking" | "warning";
  message: string;
  alternatives?: readonly DeveloperAlternative[];
};
export type DeveloperPlan = {
  schemaVersion: 1;
  offsetEncoding: "utf-16";
  captureId: string;
  generation: number;
  transcriptRevision: number;
  profileId: string;
  profileRevision: number;
  supported: boolean;
  edits: DeveloperEdit[];
  diagnostics: DeveloperDiagnostic[];
  /** Half-open source UTF-16 ranges; edit outputs are protected by composition. */
  protectedSpans: DeveloperRange[];
};
export type DeveloperPlanRequest = {
  rawTranscript: string;
  mode: DeveloperMode;
  locale: string;
  profile: DeveloperProfile;
  captureId: string;
  generation: number;
  transcriptRevision: number;
  protectedSpans?: readonly DeveloperRange[];
  choices?: Readonly<Record<string, string>>;
};
export const DEVELOPER_LIMITS = Object.freeze({
  profileBytes: 65_536,
  symbols: 256,
  transcriptBytes: 131_072,
  tokens: 4_000,
  edits: 64,
  replacementBytes: 16_384,
});
