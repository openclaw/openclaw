import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enNativeLinkMenu = {
  nativeLinkMenu: {
    label: "Link actions",
    openInline: "Open in Browser Panel",
    openExternal: "Open in Default Browser",
    copy: "Copy Link",
  },
} satisfies TranslationMap;

export const registerNativeLinkMenuEnglish = Object.assign(
  () => {
    Object.assign(en.nativeLinkMenu, enNativeLinkMenu.nativeLinkMenu);
  },
  { catalog: enNativeLinkMenu },
);
