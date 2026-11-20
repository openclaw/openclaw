import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  channels: { hub: { setUp: "Set up" } },
  modelProviders: {
    login: { finishing: "Your account is being saved. Wait for the result." },
    status: { apiKey: "API key" },
  },
} satisfies TranslationMap;

export const registerModelProviderAuthEnglish = Object.assign(() => mergeCatalog(en, catalog), {
  catalog,
});
