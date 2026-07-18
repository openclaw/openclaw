// Control UI type declarations define types contracts.
import type { OpenClawLocale } from "@openclaw/localization-core";

export type TranslationMap = { [key: string]: string | TranslationMap };

export type Locale = Exclude<OpenClawLocale, "sv">;
