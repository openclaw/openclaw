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
      unavailable: "Couldn’t verify access. Check your connection and try again.",
    },
    switchGateway: {
      title: "Switch to a different Gateway?",
      summary: "This link connects to a different Gateway.",
      current: "Current",
      next: "Link",
      note: "Anything you enter after switching goes to {host}.",
      noteToken: "This link includes a token for that Gateway.",
      noteScoped: "Your saved sign-in for {host} stays here and isn’t sent.",
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
