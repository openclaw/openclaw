import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enOpenClawId = {
  openclawId: {
    errorApprovalSignIn: "Sign in with OpenClaw ID to approve another browser.",
    errorApprovalBrowser:
      "This browser cannot approve another browser. Use a different approved owner browser or your recovery kit.",
    errorApprovalTab:
      "Another tab is waiting for browsers to approve. Use that tab, or close it and retry here.",
    errorApprovalExpired:
      "This browser request expired or was cancelled. Start a new request on the other browser.",
    errorApprovalWait:
      "Wait for the verification number on both screens. Approve only if the numbers match.",
    technicalDetails: "Technical details",
    errorNotPrepared: "Setup is not ready. Close this dialog and start again.",
    errorAlreadyLinked:
      "Remote access is already set up. Close this dialog and check its status in the account menu.",
    errorNotLinked:
      "Remote access is not set up. Turn it on from the computer that runs this claw.",
    errorIssuerUnavailable: "Could not reach OpenClaw ID. Try again shortly.",
    errorIssuerInvalid:
      "Sign-in stopped because OpenClaw ID could not be verified. Ask the person who manages this claw to check its setup.",
    errorAccountInvalid:
      "Sign-in stopped because your account could not be verified. Start sign-in again.",
    errorSignInExpired: "This sign-in expired or was already used. Start sign-in again.",
    errorSignedOut: "Your OpenClaw ID sign-in expired. Sign in again.",
    errorTokenExchange: "Could not finish signing in. Start again.",
    errorVerification:
      "This change stopped because the claw or access request could not be verified. Review its details before trying again.",
    errorAddressMismatch:
      "Setup stopped because the claw address did not match. Ask the person who manages this claw to check its setup.",
    errorRegistrationMismatch:
      "Setup stopped because this claw does not match the saved ownership details. Ask the person who manages it to check its setup.",
    errorNotOwner: "Use an approved owner browser to manage access to this claw.",
    errorCapsEscalation:
      "This browser can't give another device more owner permissions than it has. Use your recovery kit to grant them.",
    errorLimitReached:
      "This claw has reached its limit for owner devices or people. Remove one to add another.",
    errorExpired:
      "This access approval expired. Use an approved owner browser or your recovery kit.",
    errorNotYetValid:
      "This access approval is not valid yet. Check the date and time on your devices.",
    errorConcurrentChange:
      "Access changed while you were making this update. Refresh and review its status before trying again.",
    errorNotPending: "This request is no longer waiting for approval. Refresh to see its status.",
    errorNameTaken: "This claw name is taken. Choose another name.",
    errorRemoteNotReady: "Remote access is not ready yet. Try again shortly.",
    errorConflict:
      "The saved setup or access details conflict with this request. Refresh and review them before trying again.",
    errorRequest: "The request could not be accepted. Check the details you entered and try again.",
    errorSignInLocal: "Sign in from OpenClaw on the computer that runs this claw.",
    errorLinkCodeUnavailable: "Could not get a link code. Try again shortly.",
    errorUnavailable: "Could not finish remote access setup. Try again shortly.",
    error_setup:
      "Could not confirm that setup finished. Check remote access in the account menu before trying again.",
    error_signIn: "Sign-in did not finish. Try again.",
    error_linkCode:
      "Could not prepare setup automatically. Get a link code from Add a claw and paste it below.",
    error_devices: "Could not load your devices. Close this dialog and try again.",
    error_remove:
      "Could not confirm that access was removed. Check Your devices before trying again.",
    error_approval:
      "Could not confirm the approval. Check Your devices. If the new browser has access, remove its access before starting a new request.",
    error_saveKit: "Could not save the kit this way. Use another option or copy it.",
    error_signOut: "Could not sign out of OpenClaw ID. Reload this page and try again.",
    error_open: "Could not open this. Try again.",
    menuTitle: "OpenClaw ID",
    stagingPreview: "Private preview · staging",
    privatePreview: "OpenClaw ID is in private preview, and {email} isn't enabled yet.",
    privatePreviewRequired:
      "OpenClaw ID is in private preview. This account isn't enabled yet. Sign out and use another account.",
    previewRegistrationSaved:
      "This claw is linked locally, but remote access is not enabled. Keep your recovery kit safe.",
    previewRegistrationRecovery:
      "Registration was refused by the private preview. Ask the preview operator to restore access, then get a new link code from Add a claw and run the publish command on this Gateway (see Technical details). Do not repeat setup or replace your recovery kit.",
    useAnotherAccount: "Sign out / use another account",
    approveNewDevice: "Approve a new device",
    approvalNotice: "A new browser is asking for owner access",
    signIn: "Sign in with OpenClaw ID",
    signInLocalOnly: "Sign in on the computer that runs this claw.",
    signInUnconfigured:
      "OpenClaw ID is not set up for this claw. Ask the person who manages it to finish setup.",
    signedIn: "Signed in to OpenClaw ID as {account}",
    signOut: "Sign out of OpenClaw ID",
    signOutReachability: "This claw stays reachable for you and the people you've invited.",
    localOperator: "Local access",
    thisComputer: "This computer",
    accountFallback: "OpenClaw ID account",
    ownerRole: "Owner",
    memberRoleOnClaw: "{role} on {claw}",
    thisClaw: "this claw",
    signInBody: "Reach this claw from other devices and invite people",
    encryptedConnection: "End-to-end encrypted",
    thisDevice: "{label} · this device",
    unnamedDevice: "Approved browser",
    invitedBy: "Invited by {owner}",
    remoteAccessOn: "Remote access on",
    online: "Online",
    offline: "Offline",
    copyRemoteLink: "Copy claw link",
    remoteLinkCopied: "Claw link copied",
    remoteLinkCopyFailed: "Could not copy the claw link. Try again.",
    yourDevices: "Your devices",
    reachOffer: "Signed in as {account}. Reach this claw from anywhere?",
    makeReachableLocalOnly:
      "To turn on remote access, open OpenClaw on the computer that runs this claw.",
    needsLoaderDomain:
      "Remote access is not set up for this claw. Ask the person who manages it to finish setup.",
    makeReachable: "Turn on remote access",
    roleOperator: "Operator",
    roleViewer: "Viewer",
  },
} satisfies TranslationMap;

/** Registers the OpenClaw ID account menu strings (loaded with the sidebar). */
export const registerOpenClawIdEnglish = Object.assign(
  () => Object.assign(en.openclawId, enOpenClawId.openclawId),
  { catalog: enOpenClawId },
);
