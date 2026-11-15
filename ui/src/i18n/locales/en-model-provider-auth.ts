import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  channels: { hub: { setUp: "Set up" } },
  modelProviders: { status: { apiKey: "API key" } },
} satisfies TranslationMap;

export const registerModelProviderAuthEnglish = Object.assign(() => mergeCatalog(en, catalog), {
  catalog,
});
