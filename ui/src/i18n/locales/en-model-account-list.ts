import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  profilePage: {
    modelAccounts: {
      loadMore: "Load more saved accounts",
      inventoryFailed: "Could not load saved accounts. Refresh to retry.",
    },
  },
} satisfies TranslationMap;

export const registerModelAccountListEnglish = Object.assign(
  () => {
    Object.assign(en.profilePage.modelAccounts, catalog.profilePage.modelAccounts);
  },
  { catalog },
);
