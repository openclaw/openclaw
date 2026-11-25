import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enNativeLinkMenu = {
  nativeLinkMenu: {
    label: "Link actions",
    openInline: "Open in browser panel",
    openExternal: "Open in default browser",
    copy: "Copy link",
  },
} satisfies TranslationMap;

export const registerNativeLinkMenuEnglish = Object.assign(
  () => {
    Object.assign(en.nativeLinkMenu, enNativeLinkMenu.nativeLinkMenu);
  },
  { catalog: enNativeLinkMenu },
);
