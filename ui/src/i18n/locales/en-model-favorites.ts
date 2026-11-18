import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    modelFavorites: {
      label: "Favorites",
      add: "Add {model} to favorites",
      remove: "Remove {model} from favorites",
      reorder: "Reorder {model}",
      unavailable: "Could not load favorites. Retry.",
      changed: "Favorites changed or could not be saved. Refresh and try again.",
    },
  },
} satisfies TranslationMap;

export const registerModelFavoritesEnglish = Object.assign(
  () => {
    Object.assign(en.chat, catalog.chat);
  },
  { catalog },
);
