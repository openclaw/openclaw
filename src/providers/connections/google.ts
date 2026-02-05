/**
 * Google Workspace connection provider.
 *
 * OAuth2 configuration for Google with Gmail, Calendar, and Drive scopes.
 * Supports granular scope selection per Google service.
 *
 * Register your OAuth App at: https://console.cloud.google.com/apis/credentials
 */

import type { ConnectionProvider, ConnectionOAuthCredential, ConnectionUserInfo } from "./types.js";
import { registerConnectionProvider } from "./registry.js";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

/** Environment variables for user-provided OAuth app */
export const GOOGLE_CLIENT_ID_ENV = "GOOGLE_OAUTH_CLIENT_ID";
export const GOOGLE_CLIENT_SECRET_ENV = "GOOGLE_OAUTH_CLIENT_SECRET";

const DEFAULT_EXPIRES_BUFFER_MS = 5 * 60 * 1000;

/**
 * Fetch user info from Google API.
 */
export async function fetchGoogleUserInfo(
  accessToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<ConnectionUserInfo | null> {
  try {
    const response = await fetchFn(GOOGLE_USERINFO_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      id?: string;
      email?: string;
      name?: string;
      picture?: string;
    };

    return {
      id: data.id,
      email: data.email,
      name: data.name,
      avatarUrl: data.picture,
    };
  } catch {
    return null;
  }
}

/**
 * Refresh Google OAuth tokens.
 */
async function refreshGoogleToken(
  cred: ConnectionOAuthCredential,
  fetchFn: typeof fetch = fetch,
): Promise<ConnectionOAuthCredential> {
  if (!cred.refresh) {
    throw new Error("Google OAuth credential is missing refresh token");
  }

  const clientId = process.env[GOOGLE_CLIENT_ID_ENV]?.trim();
  const clientSecret = process.env[GOOGLE_CLIENT_SECRET_ENV]?.trim();

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET for token refresh",
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: cred.refresh,
  });

  const response = await fetchFn(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google token refresh failed: ${text}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!data.access_token) {
    throw new Error("Google token refresh returned no access_token");
  }

  const expiresIn = data.expires_in ?? 3600;

  return {
    ...cred,
    access: data.access_token,
    // Google may return a new refresh token, but usually doesn't
    refresh: data.refresh_token ?? cred.refresh,
    expires: Date.now() + expiresIn * 1000 - DEFAULT_EXPIRES_BUFFER_MS,
  };
}

export const googleConnectionProvider: ConnectionProvider = {
  id: "google",
  label: "Google Workspace",
  icon: "google",
  docsPath: "/connections/google",
  oauth: {
    authorizeUrl: GOOGLE_AUTHORIZE_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    userInfoUrl: GOOGLE_USERINFO_URL,
    pkceRequired: true,
    clientIdEnvVar: GOOGLE_CLIENT_ID_ENV,
    clientSecretEnvVar: GOOGLE_CLIENT_SECRET_ENV,
    defaultRedirectPath: "/oauth/callback/google",
    // Request offline access to get refresh token
    authorizeParams: {
      access_type: "offline",
      prompt: "consent",
    },
    scopes: [
      // Basic profile
      {
        id: "openid",
        label: "OpenID Connect",
        description: "Basic authentication",
        risk: "low",
        required: true,
      },
      {
        id: "profile",
        label: "Profile info",
        description: "View your basic profile info",
        risk: "low",
        required: true,
      },
      {
        id: "email",
        label: "Email address",
        description: "View your email address",
        risk: "low",
        required: true,
      },

      // Gmail scopes
      {
        id: "https://www.googleapis.com/auth/gmail.readonly",
        label: "Read emails",
        description: "Read all emails and settings",
        risk: "high",
        examples: ["Search emails", "Read inbox", "View labels"],
      },
      {
        id: "https://www.googleapis.com/auth/gmail.send",
        label: "Send emails",
        description: "Send emails on your behalf",
        risk: "high",
        examples: ["Send emails", "Reply to emails"],
      },
      {
        id: "https://www.googleapis.com/auth/gmail.compose",
        label: "Compose emails",
        description: "Create and edit email drafts",
        risk: "medium",
        examples: ["Create drafts", "Edit drafts"],
      },
      {
        id: "https://www.googleapis.com/auth/gmail.labels",
        label: "Manage labels",
        description: "Create and manage email labels",
        risk: "low",
        examples: ["Create labels", "Organize emails"],
      },
      {
        id: "https://www.googleapis.com/auth/gmail.modify",
        label: "Modify emails",
        description: "Read, compose, send, and modify emails",
        risk: "high",
        examples: ["Archive emails", "Mark as read", "Delete emails"],
        implies: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.compose",
        ],
      },

      // Calendar scopes
      {
        id: "https://www.googleapis.com/auth/calendar.readonly",
        label: "Read calendars",
        description: "View your calendars and events",
        risk: "low",
        recommended: true,
        examples: ["View events", "Check availability"],
      },
      {
        id: "https://www.googleapis.com/auth/calendar.events",
        label: "Manage events",
        description: "View and edit events on your calendars",
        risk: "medium",
        examples: ["Create events", "Update events", "Delete events"],
        implies: ["https://www.googleapis.com/auth/calendar.readonly"],
      },
      {
        id: "https://www.googleapis.com/auth/calendar",
        label: "Full calendar access",
        description: "See, edit, share, and delete calendars",
        risk: "high",
        examples: ["Create calendars", "Share calendars", "Full management"],
        implies: ["https://www.googleapis.com/auth/calendar.events"],
      },
      {
        id: "https://www.googleapis.com/auth/calendar.events.readonly",
        label: "Read events only",
        description: "View events on your calendars",
        risk: "low",
        examples: ["List events", "Read event details"],
      },
      {
        id: "https://www.googleapis.com/auth/calendar.settings.readonly",
        label: "Read calendar settings",
        description: "View your calendar settings",
        risk: "low",
        examples: ["Get timezone", "View preferences"],
      },

      // Drive scopes
      {
        id: "https://www.googleapis.com/auth/drive.readonly",
        label: "Read Drive files",
        description: "View and download your Google Drive files",
        risk: "medium",
        recommended: true,
        examples: ["List files", "Download files", "Search files"],
      },
      {
        id: "https://www.googleapis.com/auth/drive.file",
        label: "Files created by app",
        description: "View and manage files created by this app",
        risk: "low",
        examples: ["Upload files", "Manage app files"],
      },
      {
        id: "https://www.googleapis.com/auth/drive",
        label: "Full Drive access",
        description: "See, edit, create, and delete all Drive files",
        risk: "high",
        examples: ["Full file management", "Organize folders", "Share files"],
        implies: ["https://www.googleapis.com/auth/drive.readonly"],
      },
      {
        id: "https://www.googleapis.com/auth/drive.metadata.readonly",
        label: "Read file metadata",
        description: "View metadata for files in Drive",
        risk: "low",
        examples: ["List files", "Get file info"],
      },
      {
        id: "https://www.googleapis.com/auth/drive.appdata",
        label: "App data folder",
        description: "Access app-specific data in Drive",
        risk: "low",
        examples: ["Store app settings", "Sync app data"],
      },

      // Docs scopes
      {
        id: "https://www.googleapis.com/auth/documents.readonly",
        label: "Read Google Docs",
        description: "View your Google Docs documents",
        risk: "medium",
        examples: ["Read documents", "Export content"],
      },
      {
        id: "https://www.googleapis.com/auth/documents",
        label: "Edit Google Docs",
        description: "View and manage your Google Docs",
        risk: "medium",
        examples: ["Create documents", "Edit content"],
        implies: ["https://www.googleapis.com/auth/documents.readonly"],
      },

      // Sheets scopes
      {
        id: "https://www.googleapis.com/auth/spreadsheets.readonly",
        label: "Read Sheets",
        description: "View your Google Sheets spreadsheets",
        risk: "medium",
        examples: ["Read spreadsheets", "Export data"],
      },
      {
        id: "https://www.googleapis.com/auth/spreadsheets",
        label: "Edit Sheets",
        description: "View and manage your Google Sheets",
        risk: "medium",
        examples: ["Create spreadsheets", "Edit cells"],
        implies: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
      },

      // Slides scopes
      {
        id: "https://www.googleapis.com/auth/presentations.readonly",
        label: "Read Slides",
        description: "View your Google Slides presentations",
        risk: "medium",
        examples: ["Read presentations", "Export slides"],
      },
      {
        id: "https://www.googleapis.com/auth/presentations",
        label: "Edit Slides",
        description: "View and manage your Google Slides",
        risk: "medium",
        examples: ["Create presentations", "Edit slides"],
        implies: ["https://www.googleapis.com/auth/presentations.readonly"],
      },

      // Tasks scopes
      {
        id: "https://www.googleapis.com/auth/tasks.readonly",
        label: "Read Tasks",
        description: "View your tasks",
        risk: "low",
        examples: ["List tasks", "View task lists"],
      },
      {
        id: "https://www.googleapis.com/auth/tasks",
        label: "Manage Tasks",
        description: "Create, edit, and delete your tasks",
        risk: "low",
        examples: ["Create tasks", "Complete tasks"],
        implies: ["https://www.googleapis.com/auth/tasks.readonly"],
      },

      // Contacts scopes
      {
        id: "https://www.googleapis.com/auth/contacts.readonly",
        label: "Read contacts",
        description: "View your contacts",
        risk: "medium",
        examples: ["List contacts", "Search contacts"],
      },
      {
        id: "https://www.googleapis.com/auth/contacts",
        label: "Manage contacts",
        description: "View and edit your contacts",
        risk: "medium",
        examples: ["Create contacts", "Update contacts"],
        implies: ["https://www.googleapis.com/auth/contacts.readonly"],
      },
    ],

    scopeCategories: [
      {
        id: "profile",
        label: "Profile",
        description: "Basic profile information",
        scopes: ["openid", "profile", "email"],
      },
      {
        id: "gmail",
        label: "Gmail",
        description: "Email access and management",
        scopes: [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/gmail.compose",
          "https://www.googleapis.com/auth/gmail.labels",
          "https://www.googleapis.com/auth/gmail.modify",
        ],
        collapsed: true,
      },
      {
        id: "calendar",
        label: "Calendar",
        description: "Calendar and event access",
        scopes: [
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/calendar.events.readonly",
          "https://www.googleapis.com/auth/calendar.settings.readonly",
        ],
      },
      {
        id: "drive",
        label: "Drive",
        description: "File storage and management",
        scopes: [
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/drive.file",
          "https://www.googleapis.com/auth/drive",
          "https://www.googleapis.com/auth/drive.metadata.readonly",
          "https://www.googleapis.com/auth/drive.appdata",
        ],
      },
      {
        id: "docs",
        label: "Docs, Sheets & Slides",
        description: "Document editing",
        scopes: [
          "https://www.googleapis.com/auth/documents.readonly",
          "https://www.googleapis.com/auth/documents",
          "https://www.googleapis.com/auth/spreadsheets.readonly",
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/presentations.readonly",
          "https://www.googleapis.com/auth/presentations",
        ],
        collapsed: true,
      },
      {
        id: "tasks-contacts",
        label: "Tasks & Contacts",
        description: "Task and contact management",
        scopes: [
          "https://www.googleapis.com/auth/tasks.readonly",
          "https://www.googleapis.com/auth/tasks",
          "https://www.googleapis.com/auth/contacts.readonly",
          "https://www.googleapis.com/auth/contacts",
        ],
        collapsed: true,
      },
    ],

    presets: [
      {
        id: "read-only",
        label: "Read-only",
        description: "View calendars and files without write access",
        scopes: [
          "openid",
          "profile",
          "email",
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/drive.readonly",
        ],
      },
      {
        id: "calendar-drive",
        label: "Calendar & Drive",
        description: "Manage events and access files",
        scopes: [
          "openid",
          "profile",
          "email",
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/drive.file",
        ],
      },
      {
        id: "productivity",
        label: "Productivity Suite",
        description: "Calendar, Drive, Docs, Sheets access",
        scopes: [
          "openid",
          "profile",
          "email",
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/documents",
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/tasks",
        ],
      },
      {
        id: "full-access",
        label: "Full Workspace",
        description: "Complete Google Workspace access including Gmail",
        scopes: [
          "openid",
          "profile",
          "email",
          "https://www.googleapis.com/auth/gmail.modify",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/drive",
          "https://www.googleapis.com/auth/documents",
          "https://www.googleapis.com/auth/spreadsheets",
          "https://www.googleapis.com/auth/tasks",
        ],
      },
    ],
  },

  refreshToken: refreshGoogleToken,
  fetchUserInfo: fetchGoogleUserInfo,
};

// Register the provider
registerConnectionProvider(googleConnectionProvider);

export default googleConnectionProvider;
