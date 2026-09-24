import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const identity = en.profilePage.identity;

const enProfile = {
  profilePage: {
    channelIdentities: {
      title: "Channel identities",
      description:
        "Connect verified channel senders to people so their current server role applies to channel requests.",
      manage: "Manage channel identities",
      person: "Person",
      choosePerson: "Choose a person",
      channelId: "Channel",
      accountId: "Channel account ID",
      senderId: "Sender ID",
      verify:
        "Use the exact configured account and immutable sender ID. Linking attests that this account belongs to the selected person; a display name is not verification.",
      link: "Link identity",
      unlink: "Unlink",
      unlinkLabel: "Unlink {identity}",
      empty: "No channel identities linked.",
    },
    access: {
      title: "Your access",
      admin: "You have permission to manage this server.",
      write: "You have permission to send messages and make changes.",
      read: "You have permission to view server information.",
      sessionWrite: "You have permission to work in your own sessions.",
      sessionRead: "You have permission to view your own sessions.",
      limited: "This connection has a limited set of permissions.",
      limits: "Sessions, browsers, and tools may have additional restrictions.",
      help: "Missing something you need?",
      nextStep:
        "Ask your server administrator to review your access. Reconnect after they make changes.",
      reconnect: "Reconnect",
      connecting: "Connecting… Your access will appear when the connection is ready.",
      details: "Technical details",
      description:
        "These permissions were granted when you connected. A role can limit them, but does not grant extra permissions.",
      scopes: "Granted scopes",
      unknown: "Your permissions could not be confirmed.",
      none: "This connection has no permissions.",
    },
    identity: {
      title: identity.title,
      menuLabel: identity.menuLabel,
      menuButtonLabel: identity.menuButtonLabel,
      description: identity.description,
      loading: "Loading your identity…",
      profileUnavailable: "Your identity profile could not be loaded.",
      unidentified:
        "This connection has no personal profile; sign in through Cloudflare Access, Tailscale Serve, or a trusted proxy to set a name and avatar.",
      writeRequired: "Your current access does not allow profile editing.",
      avatar: identity.avatar,
      avatarDescription: "PNG, JPEG, or WebP. Images are resized to 256 × 256 or smaller.",
      chooseAvatar: identity.chooseAvatar,
      processingAvatar: "Processing…",
      displayName: identity.displayName,
      displayNameDescription: "Shown to other people using this gateway.",
      linkedEmails: identity.linkedEmails,
      linkedEmailsDescription: "Email addresses connected to this profile.",
      githubAccount: "GitHub account",
      githubAccountDescription:
        "Verified sign-in identity, not permission to publish. Manage publishing access under GitHub connections below.",
      githubVerified: "Verified from your GitHub-backed sign-in",
      githubUnavailable: "Unavailable",
      githubUnavailableDescription: "GitHub-backed sign-in is unavailable. Refresh to retry.",
      ownerGithubDescription:
        "GitHub-backed sign-in through Cloudflare Access or Tailscale Serve provides this identity.",
      gitCoauthor: "Git co-author credit",
      gitCoauthorDescription:
        "Adds this account's public GitHub noreply address to commits created from shared sessions. Turning it off affects future commits only.",
      gitCoauthorUnavailable:
        "Available after your GitHub-backed sign-in is verified. Refresh to retry.",
      ownerGitCoauthorDescription:
        "Requires GitHub-backed sign-in through Cloudflare Access or Tailscale Serve.",
      avatarErrors: {
        invalid: "That image could not be processed.",
        sourceTooLarge: "Choose an image that is 10 MB or smaller.",
        tooLarge: "The processed avatar is larger than 512 KB.",
      },
    },
  },
} satisfies TranslationMap;

export const registerProfileEnglish = Object.assign(
  () => {
    // Shared menu/search labels stay eager; editor copy loads with its consumers.
    en.profilePage.access = enProfile.profilePage.access;
    en.profilePage.channelIdentities = enProfile.profilePage.channelIdentities;
    Object.assign(en.profilePage.identity, enProfile.profilePage.identity);
  },
  { catalog: enProfile },
);
