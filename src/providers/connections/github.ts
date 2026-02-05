/**
 * GitHub connection provider.
 *
 * OAuth2 configuration for GitHub with granular scope selection.
 * Supports repository access, organization membership, and workflow permissions.
 *
 * Register your OAuth App at: https://github.com/settings/developers
 */

import type { ConnectionProvider, ConnectionOAuthCredential, ConnectionUserInfo } from "./types.js";
import { registerConnectionProvider } from "./registry.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";

/** Environment variables for user-provided OAuth app */
export const GITHUB_CLIENT_ID_ENV = "GITHUB_OAUTH_CLIENT_ID";
export const GITHUB_CLIENT_SECRET_ENV = "GITHUB_OAUTH_CLIENT_SECRET";

/**
 * Fetch user info from GitHub API.
 */
export async function fetchGitHubUserInfo(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<ConnectionUserInfo | null> {
  try {
    const response = await fetchFn(GITHUB_USER_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      id?: number;
      login?: string;
      name?: string;
      email?: string;
      avatar_url?: string;
    };

    return {
      id: data.id?.toString(),
      username: data.login,
      name: data.name ?? undefined,
      email: data.email ?? undefined,
      avatarUrl: data.avatar_url,
    };
  } catch {
    return null;
  }
}

/**
 * GitHub OAuth tokens don't expire and don't have refresh tokens.
 * This is a no-op refresh that just returns the existing credential.
 */
async function refreshGitHubToken(
  cred: ConnectionOAuthCredential,
): Promise<ConnectionOAuthCredential> {
  // GitHub OAuth tokens don't expire; they're valid until revoked
  // Just return the existing credential
  return cred;
}

export const githubConnectionProvider: ConnectionProvider = {
  id: "github",
  label: "GitHub",
  icon: "github",
  docsPath: "/connections/github",
  oauth: {
    authorizeUrl: GITHUB_AUTHORIZE_URL,
    tokenUrl: GITHUB_TOKEN_URL,
    userInfoUrl: GITHUB_USER_URL,
    pkceRequired: false, // GitHub doesn't require PKCE for OAuth Apps
    clientIdEnvVar: GITHUB_CLIENT_ID_ENV,
    clientSecretEnvVar: GITHUB_CLIENT_SECRET_ENV,
    defaultRedirectPath: "/oauth/callback/github",
    scopes: [
      // Repository scopes
      {
        id: "repo",
        label: "Full repository access",
        description: "Read and write access to public and private repositories",
        risk: "high",
        recommended: true,
        examples: [
          "Clone private repositories",
          "Push commits",
          "Create branches",
          "Manage pull requests",
        ],
        implies: ["repo:status", "repo_deployment", "public_repo"],
      },
      {
        id: "public_repo",
        label: "Public repositories only",
        description: "Read and write access to public repositories",
        risk: "medium",
        examples: ["Fork public repos", "Create public PRs", "Comment on issues"],
      },
      {
        id: "repo:status",
        label: "Commit statuses",
        description: "Read and write commit status",
        risk: "low",
        examples: ["Check CI status", "Update commit checks"],
      },
      {
        id: "repo_deployment",
        label: "Deployments",
        description: "Access deployment statuses",
        risk: "low",
        examples: ["View deployments", "Create deployment statuses"],
      },

      // Organization scopes
      {
        id: "read:org",
        label: "Read organization",
        description: "Read organization membership and team info",
        risk: "low",
        recommended: true,
        examples: ["List org members", "View team membership"],
      },
      {
        id: "write:org",
        label: "Write organization",
        description: "Manage organization membership",
        risk: "high",
        examples: ["Invite members", "Manage teams"],
        implies: ["read:org"],
      },
      {
        id: "admin:org",
        label: "Admin organization",
        description: "Full organization access including billing",
        risk: "high",
        examples: ["Manage org settings", "View billing"],
        implies: ["write:org", "read:org"],
      },

      // User scopes
      {
        id: "read:user",
        label: "Read user profile",
        description: "Read user profile data",
        risk: "low",
        examples: ["View profile info", "Get email addresses"],
      },
      {
        id: "user:email",
        label: "Email addresses",
        description: "Access user email addresses",
        risk: "low",
        examples: ["Get verified emails"],
      },

      // Project scopes
      {
        id: "read:project",
        label: "Read projects",
        description: "Read access to projects",
        risk: "low",
        examples: ["View project boards", "List project items"],
      },
      {
        id: "project",
        label: "Full project access",
        description: "Read and write access to projects",
        risk: "medium",
        examples: ["Create projects", "Manage project items"],
        implies: ["read:project"],
      },

      // Workflow scopes
      {
        id: "workflow",
        label: "GitHub Actions workflows",
        description: "Update GitHub Actions workflow files",
        risk: "high",
        examples: ["Modify CI/CD pipelines", "Update workflow definitions"],
      },

      // Gist scopes
      {
        id: "gist",
        label: "Gists",
        description: "Create and manage gists",
        risk: "low",
        examples: ["Create gists", "Update gists"],
      },

      // Notifications
      {
        id: "notifications",
        label: "Notifications",
        description: "Access notifications",
        risk: "low",
        examples: ["Read notifications", "Mark as read"],
      },

      // Discussion scopes
      {
        id: "read:discussion",
        label: "Read discussions",
        description: "Read access to discussions",
        risk: "low",
        examples: ["View discussions"],
      },
      {
        id: "write:discussion",
        label: "Write discussions",
        description: "Create and manage discussions",
        risk: "medium",
        examples: ["Create discussions", "Comment on discussions"],
        implies: ["read:discussion"],
      },
    ],

    scopeCategories: [
      {
        id: "repository",
        label: "Repository",
        description: "Access to repositories and code",
        scopes: ["repo", "public_repo", "repo:status", "repo_deployment"],
      },
      {
        id: "organization",
        label: "Organization",
        description: "Organization membership and teams",
        scopes: ["read:org", "write:org", "admin:org"],
        collapsed: true,
      },
      {
        id: "user",
        label: "User",
        description: "User profile information",
        scopes: ["read:user", "user:email"],
        collapsed: true,
      },
      {
        id: "projects",
        label: "Projects",
        description: "GitHub Projects",
        scopes: ["read:project", "project"],
        collapsed: true,
      },
      {
        id: "automation",
        label: "Automation",
        description: "Workflows and notifications",
        scopes: ["workflow", "notifications"],
        collapsed: true,
      },
      {
        id: "other",
        label: "Other",
        description: "Gists and discussions",
        scopes: ["gist", "read:discussion", "write:discussion"],
        collapsed: true,
      },
    ],

    presets: [
      {
        id: "read-only",
        label: "Read-only",
        description: "Read access to repos and org info (no write permissions)",
        scopes: ["public_repo", "repo:status", "read:org", "read:user", "read:project"],
      },
      {
        id: "developer",
        label: "Developer",
        description: "Full repo access and organization membership",
        scopes: ["repo", "read:org", "read:user", "user:email", "read:project"],
      },
      {
        id: "full-access",
        label: "Full access",
        description: "All repository, workflow, and project permissions",
        scopes: ["repo", "read:org", "workflow", "project", "read:user", "user:email", "gist"],
      },
    ],
  },

  refreshToken: refreshGitHubToken,
  fetchUserInfo: fetchGitHubUserInfo,
};

// Register the provider
registerConnectionProvider(githubConnectionProvider);

export default githubConnectionProvider;
