/**
 * Slack connection provider.
 *
 * OAuth2 configuration for Slack with bot token scopes.
 * Supports messaging, channel access, and user info.
 *
 * Register your Slack App at: https://api.slack.com/apps
 */

import type { ConnectionProvider, ConnectionOAuthCredential, ConnectionUserInfo } from "./types.js";
import { registerConnectionProvider } from "./registry.js";

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";

/** Environment variables for user-provided OAuth app */
export const SLACK_CLIENT_ID_ENV = "SLACK_OAUTH_CLIENT_ID";
export const SLACK_CLIENT_SECRET_ENV = "SLACK_OAUTH_CLIENT_SECRET";

/**
 * Fetch bot/user info from Slack API.
 */
export async function fetchSlackUserInfo(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<ConnectionUserInfo | null> {
  try {
    const response = await fetchFn(SLACK_AUTH_TEST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      ok?: boolean;
      user_id?: string;
      user?: string;
      team?: string;
      team_id?: string;
      bot_id?: string;
    };

    if (!data.ok) {
      return null;
    }

    return {
      id: data.user_id ?? data.bot_id,
      username: data.user,
      name: data.team,
    };
  } catch {
    return null;
  }
}

/**
 * Slack tokens can be rotated. This handles token refresh if rotation is enabled.
 */
async function refreshSlackToken(
  cred: ConnectionOAuthCredential,
  fetchFn: typeof fetch = fetch,
): Promise<ConnectionOAuthCredential> {
  // Slack tokens don't expire by default unless token rotation is enabled
  // If refresh token exists and token is expired, attempt refresh
  if (!cred.refresh || !cred.expires || Date.now() < cred.expires) {
    return cred;
  }

  const clientId = process.env[SLACK_CLIENT_ID_ENV]?.trim();
  const clientSecret = process.env[SLACK_CLIENT_SECRET_ENV]?.trim();

  if (!clientId || !clientSecret) {
    throw new Error("Missing SLACK_OAUTH_CLIENT_ID or SLACK_OAUTH_CLIENT_SECRET for token refresh");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: cred.refresh,
  });

  const response = await fetchFn(SLACK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    throw new Error(`Slack token refresh failed: ${response.statusText}`);
  }

  const data = (await response.json()) as {
    ok?: boolean;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (!data.ok || !data.access_token) {
    throw new Error(`Slack token refresh failed: ${data.error ?? "Unknown error"}`);
  }

  const expiresIn = data.expires_in ?? 43200; // Default 12 hours
  const bufferMs = 5 * 60 * 1000; // 5 minute buffer

  return {
    ...cred,
    access: data.access_token,
    refresh: data.refresh_token ?? cred.refresh,
    expires: Date.now() + expiresIn * 1000 - bufferMs,
  };
}

export const slackConnectionProvider: ConnectionProvider = {
  id: "slack",
  label: "Slack",
  icon: "slack",
  docsPath: "/connections/slack",
  oauth: {
    authorizeUrl: SLACK_AUTHORIZE_URL,
    tokenUrl: SLACK_TOKEN_URL,
    pkceRequired: false,
    clientIdEnvVar: SLACK_CLIENT_ID_ENV,
    clientSecretEnvVar: SLACK_CLIENT_SECRET_ENV,
    defaultRedirectPath: "/oauth/callback/slack",
    scopeSeparator: ",",
    scopes: [
      // Messaging scopes
      {
        id: "chat:write",
        label: "Send messages",
        description: "Send messages as the bot",
        risk: "medium",
        required: true,
        examples: ["Post messages to channels", "Send DMs"],
      },
      {
        id: "chat:write.public",
        label: "Send to public channels",
        description: "Send messages to public channels the bot isn't a member of",
        risk: "medium",
        examples: ["Post announcements", "Broadcast messages"],
      },
      {
        id: "chat:write.customize",
        label: "Customize messages",
        description: "Send messages with custom username and avatar",
        risk: "low",
        examples: ["Brand messages", "Impersonate users (display only)"],
      },

      // Channel reading scopes
      {
        id: "channels:read",
        label: "View public channels",
        description: "View basic info about public channels",
        risk: "low",
        recommended: true,
        examples: ["List channels", "Get channel info"],
      },
      {
        id: "channels:history",
        label: "Read public channel history",
        description: "Read messages in public channels the bot is in",
        risk: "medium",
        recommended: true,
        examples: ["Search messages", "Read channel history"],
      },
      {
        id: "channels:join",
        label: "Join public channels",
        description: "Join public channels in the workspace",
        risk: "low",
        examples: ["Auto-join channels", "Discover channels"],
      },

      // Private channels (groups)
      {
        id: "groups:read",
        label: "View private channels",
        description: "View basic info about private channels the bot is in",
        risk: "medium",
        examples: ["List private channels"],
      },
      {
        id: "groups:history",
        label: "Read private channel history",
        description: "Read messages in private channels the bot is in",
        risk: "high",
        examples: ["Search private messages"],
      },
      {
        id: "groups:write",
        label: "Manage private channels",
        description: "Manage private channels the bot is in",
        risk: "high",
        examples: ["Set topic", "Invite users"],
      },

      // Direct messages
      {
        id: "im:read",
        label: "View direct messages",
        description: "View basic info about DMs the bot has",
        risk: "medium",
        examples: ["List DM conversations"],
      },
      {
        id: "im:history",
        label: "Read DM history",
        description: "Read message history in DMs with the bot",
        risk: "medium",
        recommended: true,
        examples: ["Respond to DMs", "Search DM history"],
      },
      {
        id: "im:write",
        label: "Start DMs",
        description: "Open DM conversations",
        risk: "medium",
        examples: ["Initiate conversations"],
      },

      // Multi-party DMs
      {
        id: "mpim:read",
        label: "View group DMs",
        description: "View basic info about group DMs the bot is in",
        risk: "medium",
        examples: ["List group DMs"],
      },
      {
        id: "mpim:history",
        label: "Read group DM history",
        description: "Read message history in group DMs",
        risk: "medium",
        examples: ["Search group DMs"],
      },
      {
        id: "mpim:write",
        label: "Manage group DMs",
        description: "Manage group DMs the bot is in",
        risk: "medium",
        examples: ["Set topic"],
      },

      // User scopes
      {
        id: "users:read",
        label: "View users",
        description: "View basic user info",
        risk: "low",
        recommended: true,
        examples: ["List users", "Get user profiles"],
      },
      {
        id: "users:read.email",
        label: "View user emails",
        description: "View email addresses of users",
        risk: "medium",
        examples: ["Get user email"],
      },
      {
        id: "users.profile:read",
        label: "Read user profiles",
        description: "Read user profile fields",
        risk: "low",
        examples: ["Get custom fields", "View status"],
      },

      // Reactions
      {
        id: "reactions:read",
        label: "View reactions",
        description: "View emoji reactions",
        risk: "low",
        examples: ["List reactions on messages"],
      },
      {
        id: "reactions:write",
        label: "Add reactions",
        description: "Add and remove emoji reactions",
        risk: "low",
        recommended: true,
        examples: ["React to messages", "Acknowledge tasks"],
      },

      // Files
      {
        id: "files:read",
        label: "View files",
        description: "View files shared in channels",
        risk: "medium",
        examples: ["Download shared files"],
      },
      {
        id: "files:write",
        label: "Upload files",
        description: "Upload and manage files",
        risk: "medium",
        examples: ["Share files", "Upload images"],
      },

      // Team info
      {
        id: "team:read",
        label: "View workspace info",
        description: "View basic workspace information",
        risk: "low",
        examples: ["Get workspace name", "View workspace icon"],
      },

      // App features
      {
        id: "commands",
        label: "Slash commands",
        description: "Add slash commands to the workspace",
        risk: "low",
        examples: ["Create /command"],
      },
      {
        id: "incoming-webhook",
        label: "Incoming webhooks",
        description: "Post messages via incoming webhooks",
        risk: "low",
        examples: ["Simple integrations"],
      },

      // Bookmarks
      {
        id: "bookmarks:read",
        label: "View bookmarks",
        description: "View bookmarks in channels",
        risk: "low",
        examples: ["List pinned links"],
      },
      {
        id: "bookmarks:write",
        label: "Manage bookmarks",
        description: "Add and remove bookmarks",
        risk: "low",
        examples: ["Pin links"],
      },
    ],

    scopeCategories: [
      {
        id: "messaging",
        label: "Messaging",
        description: "Send and customize messages",
        scopes: ["chat:write", "chat:write.public", "chat:write.customize"],
      },
      {
        id: "public-channels",
        label: "Public Channels",
        description: "Read and join public channels",
        scopes: ["channels:read", "channels:history", "channels:join"],
      },
      {
        id: "private-channels",
        label: "Private Channels",
        description: "Access private channels",
        scopes: ["groups:read", "groups:history", "groups:write"],
        collapsed: true,
      },
      {
        id: "direct-messages",
        label: "Direct Messages",
        description: "Access DMs with the bot",
        scopes: ["im:read", "im:history", "im:write"],
      },
      {
        id: "group-dms",
        label: "Group DMs",
        description: "Access group DMs",
        scopes: ["mpim:read", "mpim:history", "mpim:write"],
        collapsed: true,
      },
      {
        id: "users",
        label: "Users",
        description: "User information and profiles",
        scopes: ["users:read", "users:read.email", "users.profile:read"],
      },
      {
        id: "reactions-files",
        label: "Reactions & Files",
        description: "Reactions and file handling",
        scopes: ["reactions:read", "reactions:write", "files:read", "files:write"],
      },
      {
        id: "other",
        label: "Other",
        description: "Workspace info, commands, bookmarks",
        scopes: ["team:read", "commands", "incoming-webhook", "bookmarks:read", "bookmarks:write"],
        collapsed: true,
      },
    ],

    presets: [
      {
        id: "read-only",
        label: "Read-only",
        description: "Read channels and users, no messaging",
        scopes: ["channels:read", "channels:history", "users:read", "reactions:read", "team:read"],
      },
      {
        id: "messaging",
        label: "Messaging",
        description: "Basic messaging in channels and DMs",
        scopes: [
          "chat:write",
          "channels:read",
          "channels:history",
          "im:history",
          "users:read",
          "reactions:write",
        ],
      },
      {
        id: "full-bot",
        label: "Full Bot",
        description: "Complete bot functionality",
        scopes: [
          "chat:write",
          "chat:write.public",
          "channels:read",
          "channels:history",
          "channels:join",
          "im:read",
          "im:history",
          "im:write",
          "users:read",
          "reactions:read",
          "reactions:write",
          "files:read",
          "files:write",
          "team:read",
        ],
      },
    ],
  },

  refreshToken: refreshSlackToken,
  fetchUserInfo: fetchSlackUserInfo,
};

// Register the provider
registerConnectionProvider(slackConnectionProvider);

export default slackConnectionProvider;
