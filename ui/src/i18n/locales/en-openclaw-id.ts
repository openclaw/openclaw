import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enOpenClawId = {
  openclawId: {
    menuTitle: "OpenClaw ID",
    signIn: "Sign in with OpenClaw ID",
    signInLocalOnly: "Sign in from the Control UI on this machine (127.0.0.1).",
    signInUnconfigured: "Set gateway.openclawId.clientId to sign in.",
    signedIn: "Signed in to OpenClaw ID as {account}",
    signInFailed: "OpenClaw ID sign-in failed: {error}",
    signOut: "Sign out of OpenClaw ID",
    localOperator: "Local operator · Not signed in · this computer only",
    staysLocal: "Your conversations stay on this computer",
    people: "People",
    yourDevices: "Your devices",
    isReachable: "{name} is reachable",
    encrypted: "End-to-end encrypted · relays can't read it",
    reachOffer: "Signed in as {account}. Reach this claw from anywhere?",
    makeReachableLocalOnly:
      "Open the Control UI on this machine (127.0.0.1) to make it reachable. Linking never runs over a remote connection.",
    needsLoaderDomain:
      "Set gateway.openclawId.loaderDomain to choose the address this claw is reachable at.",
    actionFailed: "Couldn't open that: {error}",
    makeReachable: "Make reachable",
    regenerateOwnerKey: "Regenerate owner key",
    frozenAlert:
      "Conflicting owner-key changes reached this claw. Regenerate the owner key here to resolve them.",
  },
} satisfies TranslationMap;

/** Registers the OpenClaw ID account menu strings (loaded with the sidebar). */
export const registerOpenClawIdEnglish = Object.assign(
  () => Object.assign(en.openclawId, enOpenClawId.openclawId),
  { catalog: enOpenClawId },
);
