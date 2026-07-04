// Crestodian gateway methods host the setup/repair conversation for clients.
import { validateCrestodianChatParams } from "../../../packages/gateway-protocol/src/index.js";
import { CrestodianChatEngine } from "../../crestodian/chat-engine.js";
import { buildOnboardingWelcome } from "../../crestodian/onboarding-welcome.js";
import { formatCrestodianStartupMessage } from "../../crestodian/overview.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/**
 * `crestodian.chat` lets clients (macOS app onboarding, future UIs) run the
 * same conversational setup as `openclaw crestodian`. It is configless-safe:
 * the engine answers deterministically before any model is configured, so the
 * app can onboard a fresh machine entirely through this one method.
 *
 * Sessions are process-local by design — Crestodian state is an in-flight
 * conversation, not persisted data. The map is bounded; the oldest session is
 * evicted first, and `reset: true` starts a session over explicitly.
 */
export type CrestodianChatSession = {
  engine: CrestodianChatEngine;
  welcome: string;
  lastUsedAt: number;
};

const MAX_CRESTODIAN_SESSIONS = 8;

function evictOldestSession(sessions: Map<string, CrestodianChatSession>): void {
  if (sessions.size < MAX_CRESTODIAN_SESSIONS) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, session] of sessions) {
    if (session.lastUsedAt < oldestAt) {
      oldestAt = session.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    sessions.delete(oldestKey);
  }
}

export const crestodianHandlers: GatewayRequestHandlers = {
  "crestodian.chat": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateCrestodianChatParams, "crestodian.chat", respond)) {
      return;
    }
    const sessions = context.crestodianSessions;
    const sessionId = params.sessionId;
    if (params.reset) {
      sessions.delete(sessionId);
    }
    let session = sessions.get(sessionId);
    if (!session) {
      // The gateway surface must never install/restart its own daemon; the
      // engine's setup path honors this via surface: "gateway".
      const engine = new CrestodianChatEngine({ surface: "gateway" });
      let welcome: string;
      if (params.welcomeVariant === "onboarding") {
        welcome = await buildOnboardingWelcome({ engine });
      } else {
        welcome = formatCrestodianStartupMessage(await engine.loadOverview());
        engine.noteAssistantMessage(welcome);
      }
      evictOldestSession(sessions);
      session = { engine, welcome, lastUsedAt: Date.now() };
      sessions.set(sessionId, session);
      if (params.message === undefined || !params.message.trim()) {
        respond(true, { sessionId, reply: session.welcome, action: "none" }, undefined);
        return;
      }
    }
    session.lastUsedAt = Date.now();
    if (params.message === undefined || !params.message.trim()) {
      respond(true, { sessionId, reply: session.welcome, action: "none" }, undefined);
      return;
    }
    const reply = await session.engine.handle(params.message);
    // The TUI-only "open-tui" handoff becomes a client-visible "open-agent"
    // signal: the app should move the user to their normal agent chat.
    const action = reply.action === "open-tui" ? "open-agent" : reply.action;
    respond(
      true,
      {
        sessionId,
        reply:
          reply.text ||
          (action === "open-agent"
            ? "Setup here is done — continue with your agent."
            : "Nothing to change."),
        action,
      },
      undefined,
    );
  },
};
