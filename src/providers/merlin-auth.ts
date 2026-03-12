import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("merlin-auth");

// Public Firebase API key for Merlin AI (getmerlin.in).
// This is intentionally public — Firebase client API keys are not secrets.
const FIREBASE_API_KEY = "AIzaSyAvCgtQ4XbmlQGIynDT-v_M8eLaXrKmtiM";

const FIREBASE_SIGN_IN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
const FIREBASE_TOKEN_REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

// Refresh 60 seconds before actual expiry to avoid races.
const TOKEN_REFRESH_BUFFER_MS = 60_000;

export interface MerlinAuthTokens {
  idToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface FirebaseSignInResponse {
  idToken: string;
  refreshToken: string;
  expiresIn: string;
  localId: string;
  email: string;
  displayName?: string;
  registered: boolean;
}

interface FirebaseRefreshResponse {
  access_token: string;
  expires_in: string;
  token_type: string;
  refresh_token: string;
  id_token: string;
  user_id: string;
  project_id: string;
}

interface FirebaseErrorResponse {
  error: {
    code: number;
    message: string;
    errors: Array<{ message: string; domain: string; reason: string }>;
  };
}

function isFirebaseError(data: unknown): data is FirebaseErrorResponse {
  return (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as FirebaseErrorResponse).error?.message === "string"
  );
}

export async function loginWithEmailPassword(
  email: string,
  password: string,
): Promise<MerlinAuthTokens> {
  const response = await fetch(FIREBASE_SIGN_IN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });

  const data = (await response.json()) as FirebaseSignInResponse | FirebaseErrorResponse;

  if (isFirebaseError(data)) {
    throw new Error(`Merlin login failed: ${data.error.message}`);
  }

  return {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    expiresAt: Date.now() + Number.parseInt(data.expiresIn, 10) * 1000,
  };
}

export async function refreshIdToken(refreshToken: string): Promise<MerlinAuthTokens> {
  const response = await fetch(FIREBASE_TOKEN_REFRESH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });

  const data = (await response.json()) as FirebaseRefreshResponse | FirebaseErrorResponse;

  if (isFirebaseError(data)) {
    throw new Error(`Merlin token refresh failed: ${data.error.message}`);
  }

  return {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + Number.parseInt(data.expires_in, 10) * 1000,
  };
}

/**
 * Manages Merlin Firebase authentication tokens with automatic refresh.
 *
 * Supports two modes:
 *   1. Email + password (full login, then refresh)
 *   2. Refresh token only (skips initial login)
 */
export class MerlinTokenManager {
  private tokens: MerlinAuthTokens | undefined;
  private refreshInFlight: Promise<MerlinAuthTokens> | undefined;

  constructor(
    private readonly email: string | undefined,
    private readonly password: string | undefined,
    private readonly initialRefreshToken: string | undefined,
  ) {}

  async getIdToken(): Promise<string> {
    if (this.tokens && Date.now() < this.tokens.expiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.tokens.idToken;
    }

    // Deduplicate concurrent refresh/login calls.
    if (this.refreshInFlight) {
      const result = await this.refreshInFlight;
      return result.idToken;
    }

    this.refreshInFlight = this.acquireTokens();
    try {
      const result = await this.refreshInFlight;
      this.tokens = result;
      return result.idToken;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async acquireTokens(): Promise<MerlinAuthTokens> {
    // Try refreshing existing token first.
    const refreshToken = this.tokens?.refreshToken ?? this.initialRefreshToken;
    if (refreshToken) {
      try {
        return await refreshIdToken(refreshToken);
      } catch (err) {
        log.warn(`Token refresh failed, falling back to login: ${String(err)}`);
      }
    }

    // Fall back to full login.
    if (this.email && this.password) {
      return loginWithEmailPassword(this.email, this.password);
    }

    throw new Error(
      "Merlin authentication failed: no valid refresh token and no email/password configured. " +
        "Set MERLIN_EMAIL + MERLIN_PASSWORD or MERLIN_REFRESH_TOKEN.",
    );
  }
}

let globalTokenManager: MerlinTokenManager | undefined;

/**
 * Get or create a shared MerlinTokenManager from environment variables.
 * Returns undefined if credentials are not configured.
 */
export function resolveMerlinTokenManager(
  env: NodeJS.ProcessEnv = process.env,
): MerlinTokenManager | undefined {
  const email = env.MERLIN_EMAIL?.trim();
  const password = env.MERLIN_PASSWORD?.trim();
  const refreshToken = env.MERLIN_REFRESH_TOKEN?.trim();

  if ((!email || !password) && !refreshToken) {
    return undefined;
  }

  if (!globalTokenManager) {
    globalTokenManager = new MerlinTokenManager(email, password, refreshToken);
  }
  return globalTokenManager;
}

/** Reset the global token manager (for testing). */
export function resetMerlinTokenManager(): void {
  globalTokenManager = undefined;
}
