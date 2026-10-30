import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enConnectionRecovery = {
  connection: {
    browserSignIn: {
      returnHint:
        "Finish signing in in the new tab, then return here. Visible attachments will retry automatically.",
      checkAgain: "Check again",
      checking: "Checking access…",
      stillRequired: "Sign-in is still required. Finish signing in, then check again.",
      unavailable: "Could not verify access. Check your connection and try again.",
    },
    switchGateway: {
      title: "Switch to a different Gateway?",
      summary: "This link asks the browser to connect somewhere else.",
      current: "Current",
      next: "Link",
      note: "Anything you enter after switching goes to that host.",
      noteToken: "The link also carries a token for it.",
      noteScoped: "Your saved credential for {host} stays here and is not sent.",
      confirm: "Switch to {host}",
      cancel: "Keep current Gateway",
    },
  },
} satisfies TranslationMap;

export const registerConnectionRecoveryEnglish = Object.assign(
  () => {
    Object.assign(en.connection.browserSignIn, enConnectionRecovery.connection.browserSignIn);
    Object.assign(en.connection.switchGateway, enConnectionRecovery.connection.switchGateway);
  },
  { catalog: enConnectionRecovery },
);
