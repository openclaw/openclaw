/**
 * Notion connection provider.
 *
 * OAuth2 configuration for Notion public integrations.
 * Notion has a simplified scope model where users select pages/databases
 * during the OAuth flow.
 *
 * Register your integration at: https://www.notion.so/my-integrations
 */

import type { ConnectionProvider, ConnectionOAuthCredential, ConnectionUserInfo } from "./types.js";
import { registerConnectionProvider } from "./registry.js";

const NOTION_AUTHORIZE_URL = "https://api.notion.com/v1/oauth/authorize";
const NOTION_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

/** Environment variables for user-provided OAuth app */
export const NOTION_CLIENT_ID_ENV = "NOTION_OAUTH_CLIENT_ID";
export const NOTION_CLIENT_SECRET_ENV = "NOTION_OAUTH_CLIENT_SECRET";

/**
 * Fetch workspace/user info from the Notion token response.
 * Notion includes workspace info in the token exchange response,
 * so we store it during the OAuth flow rather than making a separate call.
 */
export async function fetchNotionUserInfo(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<ConnectionUserInfo | null> {
  try {
    // Use the users/me endpoint to get info about the bot user
    const response = await fetchFn("https://api.notion.com/v1/users/me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": "2022-06-28",
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      id?: string;
      type?: string;
      name?: string;
      avatar_url?: string;
      bot?: {
        owner?: {
          type?: string;
          user?: {
            id?: string;
            name?: string;
            avatar_url?: string;
            person?: { email?: string };
          };
          workspace?: boolean;
        };
        workspace_name?: string;
      };
    };

    // For bot users, try to get the workspace name
    const workspaceName = data.bot?.workspace_name;
    const ownerUser = data.bot?.owner?.user;

    return {
      id: data.id,
      name: workspaceName ?? data.name,
      username: ownerUser?.name,
      email: ownerUser?.person?.email,
      avatarUrl: data.avatar_url ?? ownerUser?.avatar_url,
    };
  } catch {
    return null;
  }
}

/**
 * Notion OAuth tokens don't expire (they're valid until revoked).
 * This is a no-op refresh that just returns the existing credential.
 */
async function refreshNotionToken(
  cred: ConnectionOAuthCredential,
): Promise<ConnectionOAuthCredential> {
  // Notion OAuth tokens don't expire
  return cred;
}

export const notionConnectionProvider: ConnectionProvider = {
  id: "notion",
  label: "Notion",
  icon: "notion",
  docsPath: "/connections/notion",
  oauth: {
    authorizeUrl: NOTION_AUTHORIZE_URL,
    tokenUrl: NOTION_TOKEN_URL,
    pkceRequired: false, // Notion doesn't require PKCE
    clientIdEnvVar: NOTION_CLIENT_ID_ENV,
    clientSecretEnvVar: NOTION_CLIENT_SECRET_ENV,
    defaultRedirectPath: "/oauth/callback/notion",
    // Notion uses owner=user to request access as the authorizing user
    authorizeParams: {
      owner: "user",
    },
    // Notion's scope model is different - users pick pages during OAuth
    // These are capability-based scopes that Notion understands
    scopes: [
      {
        id: "read_content",
        label: "Read content",
        description: "Read pages and databases you share with this integration",
        risk: "low",
        required: true,
        examples: ["Read page content", "Query databases", "List pages"],
      },
      {
        id: "update_content",
        label: "Update content",
        description: "Edit pages and databases you share with this integration",
        risk: "medium",
        recommended: true,
        examples: ["Edit pages", "Update database entries", "Create content"],
      },
      {
        id: "insert_content",
        label: "Create content",
        description: "Create new pages and databases",
        risk: "medium",
        recommended: true,
        examples: ["Create pages", "Add database entries", "Create databases"],
      },
      {
        id: "read_comments",
        label: "Read comments",
        description: "Read comments on pages you share with this integration",
        risk: "low",
        examples: ["View discussions", "Read feedback"],
      },
      {
        id: "create_comments",
        label: "Create comments",
        description: "Add comments to pages you share with this integration",
        risk: "low",
        examples: ["Add feedback", "Participate in discussions"],
      },
      {
        id: "read_user_info",
        label: "User information",
        description: "See info about workspace members who interact with content",
        risk: "low",
        examples: ["See who edited", "View collaborators"],
      },
    ],

    scopeCategories: [
      {
        id: "content",
        label: "Content",
        description: "Page and database access",
        scopes: ["read_content", "update_content", "insert_content"],
      },
      {
        id: "collaboration",
        label: "Collaboration",
        description: "Comments and user info",
        scopes: ["read_comments", "create_comments", "read_user_info"],
        collapsed: true,
      },
    ],

    presets: [
      {
        id: "read-only",
        label: "Read-only",
        description: "Read pages and databases without write access",
        scopes: ["read_content", "read_comments", "read_user_info"],
      },
      {
        id: "full-access",
        label: "Full access",
        description: "Read, create, and update all shared content",
        scopes: [
          "read_content",
          "update_content",
          "insert_content",
          "read_comments",
          "create_comments",
          "read_user_info",
        ],
      },
    ],
  },

  refreshToken: refreshNotionToken,
  fetchUserInfo: fetchNotionUserInfo,
};

// Register the provider
registerConnectionProvider(notionConnectionProvider);

export default notionConnectionProvider;
