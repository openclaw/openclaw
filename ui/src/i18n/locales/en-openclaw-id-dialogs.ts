import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Strings of the OpenClaw ID dialogs (Make reachable, Your devices). They load
// with the dialogs, not with the sidebar, and merge into the openclawId namespace.
const enOpenClawIdDialogs = {
  openclawId: {
    yourDevicesBody:
      "Browsers that act as you, the owner. Each has its own key, signed by your owner key.",
    deviceLocal: "This machine (direct, no relay)",
    deviceRemote: "Over the encrypted relay",
    revoke: "Revoke",
    revokeConfirm: "Revoke {device}",
    revokeOne:
      "It disconnects at once and can come back only with your recovery kit or your approval from another device.",
    revokeCascade:
      "It disconnects at once. The devices it approved lose access too: {devices}. They can come back only with your recovery kit or your approval from another device.",
    notOwnerDevice:
      "This browser is not an owner device for this claw, so it can only list devices.",
    recoveryKitLine:
      "Your recovery kit rebuilds the owner key with fingerprint {fingerprint}. It is kept only by you.",
    signedInLinkCode: "Signed in as {account}. Your link code is ready.",
    linkCodeFailed: "Couldn't get a link code for your account: {error}. Paste one instead.",
    dialogTitle: "Make this claw reachable",
    dialogDescription: "Create a recovery kit and link this claw to it.",
    nameBody:
      "Name your claw. The name becomes its address; the ending is unique to your account, so names never collide.",
    enrollmentCode: "OpenClaw ID link code",
    enrollmentCodeHint:
      "Get one while signed in to OpenClaw ID. It lists this claw in your account.",
    getLinkCode: "Get a link code",
    clawName: "Claw name",
    clawNameHint:
      "Lower-case letters, digits and hyphens. Your address ends with your account's tag.",
    nameAvailable: "Available: https://{host}",
    nameTaken: "https://{host} is taken. Choose another name.",
    continue: "Continue",
    ownerKeyTitle: "Create your owner key",
    ownerKeyBody:
      "Your owner key decides who can use your claws and which server is really yours. It's created right here, on this computer. OpenClaw never sees it, so not even OpenClaw can add people to your claw or point your devices somewhere else.",
    ownerKeyFactKey: "Owner key",
    ownerKeyFactKeyValue: "rebuilt from your recovery kit when needed, never stored",
    ownerKeyFactBrowser: "This browser",
    ownerKeyFactBrowserValue: "gets its own device key, signed by your owner key",
    ownerKeyFactClaw: "{name} keeps",
    ownerKeyFactClawValue: "only the public half",
    createOwnerKey: "Create owner key",
    kitTitle: "Save your recovery kit",
    kitHeading: "OpenClaw Recovery Kit",
    kitBody:
      "If you lose your devices, this is how you prove you own your claws. It is shown once; keep it somewhere safe.",
    kitOwnerFingerprint: "Owner fingerprint",
    kitOwner: "Owner",
    kitClaw: "First claw",
    kitCreated: "Created",
    kitWarning:
      "Anyone with this kit can act as the owner of your claws. Never share it or read it to anyone.",
    downloadKit: "Download as text file",
    printKit: "Print or save as PDF",
    storeKit: "Save to password manager",
    kitActionUnavailable: "Your browser didn't open that. Use another option or copy the kit.",
    kitActionFailed: "That didn't work: {error}. Use another option or copy the kit.",
    kitSaved: "I've saved my recovery kit somewhere safe",
    thisBrowser: "This browser",
    linkingTitle: "Making {name} reachable",
    step_sign: "Signing {name}'s key with your owner key",
    step_sign_hint: "Your devices will only ever trust this exact server",
    step_pin: "Pinning your owner key on {name}",
    step_pin_hint: "Only your owner key can change who gets in",
    step_reserve: "Proving {name} holds its key and reserving {host}",
    step_reserve_hint: "Your permanent address",
    step_relay: "Opening an encrypted connection to the relay",
    step_relay_hint: "Outbound only: no ports opened on your network",
    stepNotPublished: "Linked, but not listed in OpenClaw ID yet ({detail}).",
    stepRelayOffline: "Not connected to the relay yet; the claw keeps trying on its own.",
    doneBody: "This claw is now linked to your recovery kit and reachable at https://{host}.",
    doneNotPublished: "It is not listed in OpenClaw ID yet. Add an enrollment code to publish it.",
    done: "Done",
    regenTitle: "Regenerate owner key",
    regenDescription: "Replace this claw's owner key and recovery kit.",
    regenBody:
      "This replaces your owner key with a new one and gives you a new recovery kit. This browser becomes the only owner device.",
    regenConsequences:
      "Every other owner device and your old recovery kit stop working at once, and their open sessions close. Members keep their access.",
    regenExpiry: "End this browser's owner access after (days)",
    regenExpiryHint: "Leave empty for no expiry.",
    regenConfirm: "Regenerate",
    regenKitBody:
      "This is your new recovery kit. It is shown only now and never leaves this page. The old kit stops working when you continue.",
    regenReplace: "Replace owner key",
    regenWorking: "Replacing the owner key…",
    regenDone:
      "The owner key is replaced. This browser is now the only owner device; keep the new recovery kit.",
  },
} satisfies TranslationMap;

/** Registers the OpenClaw ID dialog strings. */
export const registerOpenClawIdDialogsEnglish = Object.assign(
  () => Object.assign(en.openclawId, enOpenClawIdDialogs.openclawId),
  { catalog: enOpenClawIdDialogs },
);
