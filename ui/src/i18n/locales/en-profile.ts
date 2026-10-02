import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const identity = en.profilePage.identity;

const enProfile = {
  profilePage: {
    people: {
      directory: "People",
      viewBy: "View access by",
      searchPeople: "Search people",
      searchRoles: "Search roles",
      noMatches: "No matches. Try another search.",
      details: "Technical details",
      peopleView: "People",
      rolesView: "Roles",
      roles: "Configured roles",
      rolesProvenance:
        "Named profile roles come from Gateway configuration. Operator and node are built-in connection types, not a fixed list of profile roles.",
      configuredRole: "Configured role",
      defaultRole: "Default role",
      roleCeilingHint:
        "Maximums, not members' live permissions. Connection and session restrictions still apply.",
      assignedPeople: "Assigned people",
      defaultPeople: "Using the default role",
      outsideRoles: "Outside configured roles",
      retiredAssignment: "Retired assignment: {role}. Using the default.",
      noRoleMembers: "No people were returned for this group.",
      membersUnavailable:
        "The people directory is unavailable with your current access. Membership is unknown, not empty.",
      membersLoading: "Loading authorized people…",
      rolesUnavailable:
        "Configured roles are unavailable with your current access. Your own connection permissions remain available in People.",
      roleUnavailable: "This configured role is unavailable. Choose a reported definition.",
      noRoles: "No configured role definitions were reported.",
      person: "Person",
      assignedRole: "Assigned role",
      unassigned: "No assigned role",
      owner: "Gateway owner",
      policy: "Configured role limits",
      ceilingHint:
        "Maximums, not live permissions. Connection and session restrictions still apply.",
      policySource: "Configured role",
      defaultPolicy: "No role is assigned; using the default.",
      retiredPolicy: "The saved role is no longer defined; using the default.",
      ownerPolicy:
        "The shared Gateway owner is outside the named-role boundary. This is not proof of permissions on another connection.",
      rolesOff:
        "Named operator roles are not configured. Saved assignments do not limit access while this boundary is off.",
      noPolicy:
        "No usable configured role policy was reported. The role boundary denies access when no assignment or default can be resolved.",
      policyUnavailable: "The applied role policy could not be confirmed with your current access.",
      policyLoading: "Loading applied role policy…",
      agents: "Agents",
      allAgents: "All agents",
      noneAgents: "No agents",
      otherSessions: "Other people's sessions",
      others: {
        none: "No general access",
        view: "View",
        suggest: "View and suggest",
        write: "Participate",
      },
      sessionHint:
        "Session membership, draft and incognito rules, and other authorization checks still apply.",
      sandbox: "Sandbox for new sessions",
      sandboxRequired: "Required",
      sandboxInherit: "Inherit agent policy",
      sandboxHint:
        "A creation requirement, not proof that any particular existing session is sandboxed.",
      scopes: "Operator scope ceiling",
      scopeHint: "A role only limits existing grants; it cannot add permissions.",
      noScopes: "No operator scopes",
      models: "Models",
      modelsRestricted: "Additional role restriction",
      modelsInherited: "Inherit agent policy",
      modelHint: "Agent model rules and runtime requirements still apply.",
      modelSource: "Model source agent",
      defaultSource: "Configured default or system agent",
      modelAllow: "Allowed model patterns",
      modelDeny: "Excluded model patterns",
      sourceModels: "Source agent's primary and fallbacks",
      noModels: "No models",
      accessPolicy: "Required access-policy plugin",
      eligibilityHint:
        "A configured dependency, not proof of a person's current eligibility or invitation expiry.",
      thisConnection: "This connection's permissions",
      noReportedCap: "No named-role session cap reported",
      directoryDenied:
        "Your connection cannot read the people directory. You can still view your own connection permissions.",
      personUnavailable: "This profile is unavailable or cannot be read with your current access.",
      choosePerson: "Choose a person to view their assigned role and configured policy.",
      empty: "No profiles were returned.",
      unavailable: "The people directory could not be loaded. Refresh to try again.",
      offline: "Connect to the gateway to view current access information.",
      unknown: "Not reported",
      none: "None",
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
    en.profilePage.people = enProfile.profilePage.people;
    Object.assign(en.profilePage.identity, enProfile.profilePage.identity);
  },
  { catalog: enProfile },
);
