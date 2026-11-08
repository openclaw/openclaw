import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const identity = en.profilePage.identity;

const enProfile = {
  profilePage: {
    people: {
      peopleView: "People",
      rolesView: "Roles",
      viewBy: "View permissions by",
      directory: "People",
      person: "Person",
      searchPeople: "Search people",
      searchRoles: "Search roles",
      role: "Effective role",
      assignedRole: "Saved role assignment",
      noRole: "No saved role",
      assigned: "Explicit assignment",
      githubLogin: "GitHub login mapping",
      default: "Default role",
      owner: "Gateway owner",
      ownerPolicy: "The Gateway owner is not limited by a named role.",
      policy: "Configured role limits",
      ceilingHint: "Maximums, not live permissions.",
      agents: "Available agents",
      allAgents: "All configured agents",
      otherSessions: "Other people’s sessions",
      others: {
        none: "Hidden",
        view: "View only",
        suggest: "Suggest changes",
        write: "Can make changes",
      },
      sandbox: "New-session sandbox",
      sandboxRequired: "Required",
      sandboxInherit: "Inherited from agent settings",
      details: "Technical policy details",
      detailsHint:
        "Configured scopes, model rules, access programs, and other ceilings. These do not show live grants, invitation eligibility, or an existing session’s sandbox.",
      scopes: "Granted scopes",
      none: "None",
      unknown: "Not reported",
      defaultRole: "Configured default",
      thisConnection: "This connection’s permissions",
      connectionHint:
        "These are your negotiated connection grants, not another person’s permissions. Session and tool restrictions still apply.",
      noReportedCap: "No additional connection ceiling reported",
      personUnavailable: "This profile is unavailable or cannot be read with your current access.",
      directoryDenied: "Your access does not include the profile directory or role configuration.",
      unavailable: "Couldn’t load people. Refresh to try again.",
      noMatches: "No matches.",
      choosePerson: "Choose a person to inspect their configured limits.",
      rolesOff: "Named roles are not configured on this Gateway.",
      policyLoading: "Loading configured role limits…",
      policyUnavailable: "Configured role limits are unavailable. Refresh to try again.",
      offline: "Reconnect to inspect permissions.",
      members: "People using this role",
      membersHint:
        "Resolved by the Gateway from saved assignments, GitHub mappings, or the default. Not live access.",
      noMembers: "No people use this role.",
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
        "This connection has no personal profile; sign in through Cloudflare Access, Tailscale Serve, or a trusted proxy to set a name and avatar.",
      writeRequired: "You need permission to edit your profile. Ask an admin for access.",
      avatar: identity.avatar,
      avatarDescription: "PNG, JPEG, or WebP. Images are resized to 256 × 256 or smaller.",
      avatarLimits: "PNG, JPEG, or WebP.",
      chooseAvatar: identity.chooseAvatar,
      processingAvatar: "Processing…",
      displayName: identity.displayName,
      displayNameDescription: "Shown to other people using OpenClaw.",
      linkedEmails: identity.linkedEmails,
      linkedEmailsDescription: "Email addresses connected to this profile.",
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
      gitCoauthorShort: "Adds this profile’s GitHub address to shared-session commits.",
      gitCoauthorDescription:
        "When a verified account is available, adds this profile’s public GitHub noreply address or verified enterprise email address to shared-session commits, depending on the publishing host. The enterprise address is visible in commit history. Turning it off affects future commits only.",
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
      people: enProfile.profilePage.people,
    });
    en.profilePage.access = enProfile.profilePage.access;
    Object.assign(en.profilePage.identity, enProfile.profilePage.identity);
  },
  { catalog: enProfile },
);
