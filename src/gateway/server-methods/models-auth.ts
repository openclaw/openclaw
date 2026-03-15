import crypto from "node:crypto";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

type ModelAuthProvider = "openai-codex";

type ModelAuthSession = {
  id: string;
  provider: ModelAuthProvider;
  status: "pending" | "connected" | "error" | "cancelled" | "expired";
  authorizeUrl: string;
  createdAt: number;
  expiresAt: number;
  profileId?: string;
  error?: string;
};

const SESSION_TTL_MS = 10 * 60_000;
const sessions = new Map<string, ModelAuthSession>();

function gcExpiredSessions(now = Date.now()): void {
  for (const [id, session] of sessions.entries()) {
    if (session.expiresAt <= now && session.status === "pending") {
      sessions.set(id, { ...session, status: "expired" });
    }
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export const modelsAuthHandlers: GatewayRequestHandlers = {
  "models.auth.start": async ({ params, respond }) => {
    gcExpiredSessions();
    const provider = asString((params as Record<string, unknown>)?.provider) as ModelAuthProvider;
    const profileIdRaw = asString((params as Record<string, unknown>)?.profileId);

    if (provider !== "openai-codex") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unsupported provider: ${provider || "(missing)"}. v1 supports openai-codex only`,
        ),
      );
      return;
    }

    const authSessionId = crypto.randomUUID();
    const createdAt = Date.now();
    const expiresAt = createdAt + SESSION_TTL_MS;

    // NOTE: v1 scaffold. Real implementation should generate provider-backed OAuth URL.
    const authorizeUrl = `https://auth.openai.com/oauth/authorize?provider=openai-codex&session=${encodeURIComponent(authSessionId)}`;

    sessions.set(authSessionId, {
      id: authSessionId,
      provider,
      status: "pending",
      authorizeUrl,
      createdAt,
      expiresAt,
      profileId: profileIdRaw || undefined,
    });

    respond(
      true,
      {
        authSessionId,
        authorizeUrl,
        expiresAt,
      },
      undefined,
    );
  },

  "models.auth.status": async ({ params, respond }) => {
    gcExpiredSessions();
    const authSessionId = asString((params as Record<string, unknown>)?.authSessionId);
    if (!authSessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing authSessionId"),
      );
      return;
    }

    const session = sessions.get(authSessionId);
    if (!session) {
      respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "auth session not found"));
      return;
    }

    respond(
      true,
      {
        authSessionId: session.id,
        provider: session.provider,
        status: session.status,
        expiresAt: session.expiresAt,
        profileId: session.profileId,
        error: session.error,
      },
      undefined,
    );
  },

  "models.auth.cancel": async ({ params, respond }) => {
    gcExpiredSessions();
    const authSessionId = asString((params as Record<string, unknown>)?.authSessionId);
    if (!authSessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "missing authSessionId"),
      );
      return;
    }

    const session = sessions.get(authSessionId);
    if (!session) {
      respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, "auth session not found"));
      return;
    }

    sessions.set(authSessionId, { ...session, status: "cancelled" });
    respond(true, { ok: true }, undefined);
  },
};
