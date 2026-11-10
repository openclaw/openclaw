import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Strings of the OpenClaw ID dialogs (Make reachable, Your devices). They load
// with the dialogs, not with the sidebar, and merge into the openclawId namespace.
const enOpenClawIdDialogs = {
  openclawId: {
    approvalWaiting: "Waiting for the other browser’s verification number…",
    approvalCompare:
      "Compare the verification number on both screens. Approve only a browser you are setting up, and only if the numbers match. Never read the number to anyone.",
    approvalDeny: "They do not match",
    approvalApprove: "The numbers match",
    approvalEmpty:
      "No new browsers are waiting for approval. Start “Approve from another device” on the new browser.",
    approvalRequiresKey: "Use your recovery kit or another approved owner browser",
    yourDevicesBody: "Browsers that can manage this claw as you.",
    deviceLocal: "On this computer",
    deviceRemote: "Remote access",
    approvedByKit: "Approved with the recovery kit",
    approvedByDevice: "Approved by {device}",
    approvedByRemoved: "Approved by a device that was removed",
    revoke: "Remove access",
    revokeConfirm: "Remove access for {device}",
    revokeOne:
      "{device} disconnects now. To use it again, approve it from another device or use your recovery kit.",
    revokeCascade:
      "{device} loses access now, and so do the devices it approved: {devices}. To restore access, approve them from another device or use your recovery kit.",
    notOwnerDevice:
      "This browser can view devices but cannot remove their access. Use one of your approved owner browsers to make changes.",
    recoveryKitLine:
      "Keep your recovery kit safe. You need it if you lose access to all your devices.",
    signedInLinkCode: "Signed in as {account}.",
    dialogTitle: "Turn on remote access",
    dialogDescription: "Open this claw from your other devices.",
    nameBody: "Choose a name for this claw.",
    enrollmentCode: "Link code",
    enrollmentCodeHint: "Paste the code from the Add a claw page.",
    getLinkCode: "Get a link code",
    clawName: "Claw name",
    clawNameHint:
      "Use lowercase letters, numbers, and single hyphens. Start with a letter and end with a letter or number.",
    nameAvailable: "Available: https://{host}",
    nameTaken: "https://{host} is taken. Choose another name.",
    continue: "Continue",
    ownerKeyTitle: "Protect your access",
    ownerKeyBody:
      "You control who can use this claw. Save a recovery kit so you can get back in if you lose your devices.",
    createOwnerKey: "Create recovery kit",
    kitTitle: "Save your recovery kit",
    kitHeading: "OpenClaw Recovery Kit",
    kitBody:
      "Save this kit somewhere safe. You need it to recover this claw if you lose your devices. It appears only once.",
    kitOwnerFingerprint: "Recovery kit ID",
    kitOwner: "Owner",
    kitClaw: "First claw",
    kitCreated: "Created",
    kitWarning:
      "Anyone with this kit can control the claws it protects. Never share it or read it to anyone.",
    downloadKit: "Download as text file",
    printKit: "Print or save as PDF",
    kitAccount: "Account",
    kitAccountFallback: "OpenClaw recovery kit · {name}",
    kitRecoveryCode: "Recovery code",
    kitShowCode: "Show",
    kitHideCode: "Hide",
    kitPasswordManagerHint: "Your password manager can save this kit.",
    kitOtherPasswordManagers: "Other ways to save your kit are below.",
    kitOnePasswordNotes:
      "Claw address: {url}\nRecovery kit ID: {id}\nTo restore access, choose Set up this browser on the Claws site, then use your recovery kit. Paste the saved password as the recovery code.",
    kitActionUnavailable: "Your browser didn't open that. Use another option or copy the kit.",
    kitSaved: "I've saved my recovery kit somewhere safe",
    thisBrowser: "This browser",
    linkingTitle: "Turning on remote access for {name}",
    step_sign: "Securing {name}",
    step_pin: "Setting up your access",
    step_reserve: "Setting up {host}",
    step_relay: "Connecting {name}",
    stepRelayOffline: "Remote access is not connected yet. This claw will keep trying.",
    doneBody: "Your claw address is https://{host}. Keep your recovery kit safe.",
    publicationPending: "Setup is still in progress.",
    doneNeedsLinkCode:
      "A link code is needed to finish setup. Ask the person who manages this claw to complete registration.",
    done: "Done",
    setupRetrying: "This claw will keep trying to finish remote access setup.",
    publicationStopped:
      "Remote access setup could not finish. Check this claw’s remote access settings on the computer that runs it.",
    securityDetails: "Security details",
    moveKeysBody:
      "This computer gets new keys for {host}. Your devices, people, nodes and invites stay. Connected devices disconnect for a moment and reconnect by themselves.",
    moveKeysKit: "Recovery code",
    moveKeysKitHint: "The code from your recovery kit. It stays in this browser.",
    moveKeysCheck: "Check",
    moveKeysConfirm: "Confirm the new keys",
    moveKeysRoot: "Owner key",
    moveKeysRootMatches: "{fp} (matches your recovery kit)",
    moveKeysEndpoint: "Endpoint key",
    moveKeysGateway: "Gateway key",
    moveKeysBinding: "Binding",
    moveKeysMove: "Move to new keys",
    moveKeysWrongKit:
      "This recovery kit is for another claw (owner key {fp}). Use the kit made for {host}.",
    moveKeysUnverifiable:
      "The keys OpenClaw ID lists for this claw don't match your recovery kit, so nothing was signed. Ask OpenClaw ID support for help.",
    moveKeysUnavailable:
      "Could not check the keys OpenClaw ID lists for this claw. Try again shortly.",
    moveKeysBadKit: "That isn't a recovery code. Check it and try again.",
    moveKeysDone: "This claw now uses new keys.",
    regenExpiry: "End this browser's owner access after (days)",
    regenExpiryHint: "Leave empty for no expiry.",
  },
} satisfies TranslationMap;

/** Registers the OpenClaw ID dialog strings. */
export const registerOpenClawIdDialogsEnglish = Object.assign(
  () => Object.assign(en.openclawId, enOpenClawIdDialogs.openclawId),
  { catalog: enOpenClawIdDialogs },
);
