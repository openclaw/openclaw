import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  profilePage: {
    modelAccounts: {
      loadMore: "Load more saved accounts",
      inventoryFailed: "Couldn’t load saved accounts. Refresh to try again.",
    },
  },
} satisfies TranslationMap;

export const registerModelAccountListEnglish = Object.assign(
  () => {
    Object.assign(en.profilePage.modelAccounts, catalog.profilePage.modelAccounts);
  },
  { catalog },
);
