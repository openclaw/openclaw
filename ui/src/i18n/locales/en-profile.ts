import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const identity = en.profilePage.identity;

const enProfile = {
  profilePage: {
    enrollment: {
      title: "Personal profile",
      description:
        "Use your own name, preferences, and session ownership on this Gateway. No email or external sign-in required.",
      shared:
        "This is shared owner access, not a personal sign-in. Shared tokens remain separate maintenance access.",
      start: "Set up personal profile",
      newPerson: "Create a new person",
      choose: "Person",
      name: "Your name (optional)",
      create: "Use this profile",
      saving: "Setting up…",
      success: "Personal profile ready. This connection is signed in as the selected person.",
      assignmentCommitted: "Person assigned. That device will use this profile when it reconnects.",
      reconnecting: "Reconnecting to confirm your personal profile…",
      reconnect: "Reconnect to finish personal setup.",
      restricted:
        "Personal setup requires an approved owner or admin operator device. Ask an admin to review this device’s access, then reconnect.",
      conflict:
        "This device or person changed. Refresh Profile and Devices before trying again. Profiles are never merged automatically.",
      failed:
        "Personal setup did not finish. Your choices are kept; retry with the same device. {detail}",
      connectionChanged:
        "The connection changed during setup. Reconnect and check Profile before retrying.",
      directoryFailed:
        "Couldn’t load existing people. Retry the directory before selecting someone.",
      rolePreview:
        "Gateway role: {role}. Device approval may further restrict access; choosing this profile does not add permissions.",
      defaultRolePreview:
        "Your personal access follows this Gateway’s policy and device approval. It may be narrower than Shared Owner, including no administration. Shared maintenance credentials are unchanged.",
      existingHint:
        "Choose an existing person only when this device belongs to them. This does not merge profiles or grant admin access.",
      noRolePolicy: "No additional role policy is configured.",
      deviceCeiling: "Available device/setup scope ceiling: {scopes}.",
      deviceApprovalUnavailable: "Device approval is not reported in this preview.",
      defaultRole: "Default local role: {role}. Operator scope policy: {scopes}.",
      boundedRole: "Combined operator scope ceiling: {scopes}.",
      roleUnavailable:
        "Default role policy is not currently reported. Device approval remains a separate limit.",
      approvalUnavailable:
        "This device’s approval ceiling is not available here; the role policy is not a grant.",
      roleAdmission:
        "Other role restrictions and current device approval still apply. The Gateway decides access at admission.",
      idOwner: "OpenClaw ID owner certificate",
      idOwnerDescription:
        "Device ownership and recovery are separate from your personal profile. Manage ID-owned access in Access.",
      openAccess: "Open Access",
      later: "Not now",
      onboarding: "Your AI is ready. Make this Gateway personal?",
      manage: "Manage profile",
      device: "Assign a person",
      deviceDescription:
        "Attach this approved operator device to a new or existing person. Node identity is unchanged.",
    },
    discord: {
      title: "Discord account",
      description:
        "Connect your Discord identity to this profile. Your existing permissions and channel access rules still apply.",
      unavailable: "Discord account linking isn’t configured. Ask an admin to enable it.",
      gatewayAccount: "Discord account",
      connect: "Connect Discord",
      connectShort: "Connect",
      disconnect: "Disconnect",
      verified: "Verified",
      notConnected: "Not connected",
      waiting: "Waiting for Discord…",
      continue: "Continue in Discord",
      reconnect: "Reconnect to manage your Discord account.",
      startFailed: "Couldn’t start Discord sign-in. Try again.",
      incomplete: "Couldn’t complete Discord sign-in. Try again.",
    },
    openclawId: {
      title: "OpenClaw ID",
      notLinked: "Not linked",
      unavailable: "Link over a personal sign-in, such as Tailscale",
      loadFailed: "Couldn’t load your OpenClaw ID link.",
      link: "Link OpenClaw ID",
      linkShort: "Link",
      unlink: "Unlink",
      ownerOf: "{email} · Owner of {claw}",
      linkedElsewhere:
        "This OpenClaw ID is already linked to another profile. Merge that profile into this one in Users, or unlink it there first.",
      profileLinked:
        "This profile is already linked to an OpenClaw ID. Unlink it first to link another.",
      failed: "Couldn’t update the OpenClaw ID link. Try again.",
    },
    access: {
      title: "Your access",
      admin: "You have admin access.",
      write: "You have permission to send messages and make changes.",
      read: "You can view settings and activity.",
      sessionWrite: "You have permission to work in your own sessions.",
      sessionRead: "You have permission to view your own sessions.",
      limited: "Your access is limited.",
      limits: "Sessions, browsers, and tools may have additional restrictions.",
      help: "Missing something you need?",
      nextStep: "Ask your admin to review your access. Reconnect after they make changes.",
      reconnect: "Reconnect",
      adminRequest: "Admin access",
      adminRequestHint:
        "Request admin access for this browser. An admin must approve this device separately.",
      connecting: "Connecting… Your access will appear when the connection is ready.",
      details: "Show details",
      description:
        "These permissions were granted when you connected. A role can limit them, but does not grant extra permissions.",
      scopes: "Granted scopes",
      unknown: "Couldn’t confirm your access. Reconnect to try again.",
      none: "This connection has no permissions.",
    },
    identity: {
      title: identity.title,
      menuLabel: identity.menuLabel,
      menuButtonLabel: identity.menuButtonLabel,
      description: identity.description,
      loading: "Loading your identity…",
      profileUnavailable: "Couldn’t load your profile. Try again.",
      unidentified:
        "This connection has no personal profile. An owner or admin can attach an approved operator device below; external sign-in is optional.",
      writeRequired: "You need permission to edit your profile. Ask an admin for access.",
      avatar: identity.avatar,
      avatarDescription: "PNG, JPEG, or WebP. Images are resized to 256 × 256 or smaller.",
      avatarLimits: "PNG, JPEG, or WebP.",
      chooseAvatar: identity.chooseAvatar,
      processingAvatar: "Processing…",
      displayName: identity.displayName,
      displayNameDescription: "Shown to other people using OpenClaw.",
      linkedEmails: identity.linkedEmails,
      linkedEmailsDescription:
        "Used for sign-in and profile linking. Commit credit can use a different address.",
      attribution: identity.attribution,
      githubAccount: "GitHub sign-in",
      githubAccountDescription:
        "Verified sign-in identity, not permission to publish. Manage publishing access separately.",
      githubVerified: "Verified",
      githubUnavailable: "Unavailable",
      githubUnavailableDescription:
        "No single verified GitHub sign-in account is available to display.",
      ownerGithubDescription:
        "GitHub-backed sign-in through Cloudflare Access or Tailscale Serve provides this identity.",
      gitCoauthor: "Git co-author credit",
      gitCoauthorShort:
        "Adds the GitHub identity selected for the publishing host to public commit history.",
      gitCoauthorDescription:
        "When available, adds this profile’s organization-provided details, public GitHub noreply address or verified enterprise email address to shared-session commits. The email address is visible in commit history. Turning it off affects future commits only.",
      gitCoauthorChanged: "Credit details changed. Review them and enable credit again.",
      gitCoauthorOrganization:
        "Adds the name and email supplied by your organization to public commit history.",
      gitCoauthorGithub:
        "Adds your verified GitHub identity to commits using its public noreply address.",
      gitCoauthorConfigure:
        "Ask your administrator to supply co-author details through your sign-in proxy, or use supported GitHub sign-in.",
      ownerGitCoauthorDescription:
        "Requires GitHub-backed sign-in through Cloudflare Access or Tailscale Serve.",
      prAttribution: "Add OpenClaw attribution to pull requests",
      prAttributionShort: "Appends this link to new pull requests:",
      prAttributionDescription:
        "Appends this link to new pull requests. Off by default and separate from Git co-author credit. Does not add work-session links.",
      prAttributionLink: "🦞 Made with OpenClaw",
      avatarErrors: {
        invalid: "Couldn’t process that image. Try another image.",
        sourceTooLarge: "Choose an image that is 10 MB or smaller.",
        tooLarge: "The processed avatar is larger than 512 KB.",
      },
    },
  },
} satisfies TranslationMap;

export const registerProfileEnglish = Object.assign(
  () => {
    // Shared menu/search labels stay eager; editor copy loads with its consumers.
    Object.assign(en.profilePage, {
      discord: enProfile.profilePage.discord,
      enrollment: enProfile.profilePage.enrollment,
      openclawId: enProfile.profilePage.openclawId,
    });
    en.profilePage.access = enProfile.profilePage.access;
    Object.assign(en.profilePage.identity, enProfile.profilePage.identity);
  },
  { catalog: enProfile },
);
