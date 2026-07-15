import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
// OpenClaw gateway methods host the setup/repair conversation for clients.
import {
  ErrorCodes,
  errorShape,
  validateSystemAgentChatParams,
  validateSystemAgentSetupActivateParams,
  validateSystemAgentSetupAuthStartParams,
  validateSystemAgentSetupDetectParams,
  validateSystemAgentSetupVerifyParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { enqueueCommandInLane, setCommandLaneConcurrency } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { defaultRuntime } from "../../runtime.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import { isSystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import { buildOnboardingWelcome } from "../../system-agent/onboarding-welcome.js";
import { formatSystemAgentStartupMessage } from "../../system-agent/overview.js";
import { WizardSession } from "../../wizard/session.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/**
 * `openclaw.chat` lets clients (macOS app onboarding, future UIs) run the
 * same conversational setup as `openclaw setup`. Structured setup owns
 * the pre-inference phase; a new chat session starts only after a live model
 * turn succeeds.
 *
 * Sessions are process-local by design — OpenClaw state is an in-flight
 * conversation, not persisted data. The map is bounded; the oldest session is
 * evicted first, and `reset: true` starts a session over explicitly.
 */
export type SystemAgentChatSession =
  GatewayRequestContext["systemAgentSessions"] extends Map<string, infer Session> ? Session : never;

const MAX_SYSTEM_AGENT_SESSIONS = 8;
const PROVIDER_AUTH_SESSION_TIMEOUT_MS = 25 * 60 * 1000;
const SYSTEM_AGENT_GATEWAY_EXECUTION_KEY = "gateway";
const systemAgentGatewayExecutionQueue = new KeyedAsyncQueue();
const systemAgentSessionQueues = new WeakMap<
  Map<string, SystemAgentChatSession>,
  KeyedAsyncQueue
>();

function getSystemAgentSessionQueue(
  sessions: Map<string, SystemAgentChatSession>,
): KeyedAsyncQueue {
  let queue = systemAgentSessionQueues.get(sessions);
  if (!queue) {
    queue = new KeyedAsyncQueue();
    systemAgentSessionQueues.set(sessions, queue);
  }
  return queue;
}

async function runSystemAgentGatewayTask<T>(task: () => Promise<T>): Promise<T> {
  // Track every accepted RPC as active, never queued: restart draining snapshots
  // active ids, so a queued OpenClaw request could otherwise outlive its socket.
  setCommandLaneConcurrency(CommandLane.SystemAgent, Number.MAX_SAFE_INTEGER);
  return await enqueueCommandInLane(CommandLane.SystemAgent, () =>
    // Bound expensive detection, activation, and agent turns without hiding
    // accepted work from restart draining. This also makes session eviction and
    // setup writes atomic with respect to other OpenClaw gateway requests.
    systemAgentGatewayExecutionQueue.enqueue(SYSTEM_AGENT_GATEWAY_EXECUTION_KEY, task),
  );
}

let systemAgentSetupActivationInProgress = false;

class SystemAgentSetupActivationBusyError extends Error {}

/** Admit one setup mutation without queueing work past a caller timeout. */
export async function runExclusiveSystemAgentSetupActivation<T>(
  task: () => Promise<T>,
): Promise<T> {
  if (systemAgentSetupActivationInProgress) {
    throw new SystemAgentSetupActivationBusyError(
      "OpenClaw setup is already in progress; try again when it finishes.",
    );
  }
  systemAgentSetupActivationInProgress = true;
  try {
    return await task();
  } finally {
    systemAgentSetupActivationInProgress = false;
  }
}

async function evictOldestSession(sessions: Map<string, SystemAgentChatSession>): Promise<void> {
  if (sessions.size < MAX_SYSTEM_AGENT_SESSIONS) {
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
    await sessions.get(oldestKey)?.engine.dispose();
    sessions.delete(oldestKey);
  }
}

export const systemAgentHandlers: GatewayRequestHandlers = {
  /** Structured onboarding: list reusable AI access on this host. */
  "openclaw.setup.detect": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupDetectParams,
        "openclaw.setup.detect",
        respond,
      )
    ) {
      return;
    }
    await runSystemAgentGatewayTask(async () => {
      const { detectSetupInference } = await import("../../system-agent/setup-inference.js");
      respond(true, await detectSetupInference(), undefined);
    });
  },
  /** Re-run the exact current default-agent inference route without mutating setup. */
  "openclaw.setup.verify": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupVerifyParams,
        "openclaw.setup.verify",
        respond,
      )
    ) {
      return;
    }
    await runSystemAgentGatewayTask(async () => {
      const { verifySetupInference } = await import("../../system-agent/setup-inference.js");
      respond(true, await verifySetupInference({ runtime: defaultRuntime }), undefined);
    });
  },
  /** Start one provider-owned OAuth/device-code login over the shared wizard transport. */
  "openclaw.setup.auth.start": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupAuthStartParams,
        "openclaw.setup.auth.start",
        respond,
      )
    ) {
      return;
    }
    if (context.findRunningWizard()) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "wizard already running"));
      return;
    }
    const sessionId = params.sessionId;
    const session = new WizardSession(
      async (prompter, signal) => {
        // Match setup.activate's lock order: setup admission before the Gateway
        // queue. Both stay held for the session, so a relaunched client cannot
        // start competing setup work while this server-owned flow can commit.
        const result = await runExclusiveSystemAgentSetupActivation(async () =>
          runSystemAgentGatewayTask(async () => {
            const { activateSetupInference } =
              await import("../../system-agent/setup-inference.js");
            return await activateSetupInference({
              kind: "provider-auth",
              authChoice: params.authChoice,
              ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
              surface: "gateway",
              runtime: {
                ...defaultRuntime,
                exit: (code: number | undefined): never => {
                  throw new Error(`setup step exited with code ${String(code)}`);
                },
              },
              prompter,
              signal,
              isCancelled: () => signal.aborted,
              onCommitStarted: () => session.lockCancellation(),
            });
          }),
        );
        if (!result.ok) {
          throw new Error(result.error);
        }
      },
      { timeoutMs: PROVIDER_AUTH_SESSION_TIMEOUT_MS },
    );
    context.wizardSessions.set(sessionId, session);
    // Return ownership immediately so the client can cancel while provider auth waits.
    respond(true, { sessionId, done: false, status: "running" }, undefined);
  },
  /**
   * Structured onboarding: live-test one candidate and persist it on success.
   * Single-flight per gateway process because testing and persistence span
   * multiple config/plugin mutations. Concurrent callers fail fast instead of
   * queueing work that could outlive their RPC timeout. A failed attempt never
   * commits a broken model, managed plugin install, or setup state.
   */
  "openclaw.setup.activate": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupActivateParams,
        "openclaw.setup.activate",
        respond,
      )
    ) {
      return;
    }
    try {
      await runExclusiveSystemAgentSetupActivation(async () => {
        await runSystemAgentGatewayTask(async () => {
          const { activateSetupInference } = await import("../../system-agent/setup-inference.js");
          const runtime = {
            ...defaultRuntime,
            // Setup runs inside the gateway process; a failing sub-step must reject
            // the RPC, never exit the daemon.
            exit: (code: number | undefined): never => {
              throw new Error(`setup step exited with code ${String(code)}`);
            },
          };
          const result = await activateSetupInference({
            kind: params.kind,
            ...(params.modelRef !== undefined ? { modelRef: params.modelRef } : {}),
            ...(params.authChoice !== undefined ? { authChoice: params.authChoice } : {}),
            ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
            ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
            surface: "gateway",
            runtime,
          });
          respond(true, result, undefined);
        });
      });
    } catch (error) {
      if (!(error instanceof SystemAgentSetupActivationBusyError)) {
        throw error;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error.message, { retryable: true }),
      );
    }
  },
  "openclaw.chat": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateSystemAgentChatParams, "openclaw.chat", respond)) {
      return;
    }
    await runSystemAgentGatewayTask(async () => {
      const sessions = context.systemAgentSessions;
      const sessionId = params.sessionId;
      // Initialization, resets, and turns share one per-session queue. Without
      // it, concurrent first messages can create competing engines and lose
      // conversation state when the later initializer replaces the first.
      await getSystemAgentSessionQueue(sessions).enqueue(sessionId, async () => {
        if (params.reset) {
          const existing = sessions.get(sessionId);
          sessions.delete(sessionId);
          await existing?.engine.dispose();
        }
        let session = sessions.get(sessionId);
        if (!session) {
          const { verifySetupInference } = await import("../../system-agent/setup-inference.js");
          const inference = await verifySetupInference({
            runtime: defaultRuntime,
            bindSession: true,
          });
          if (!inference.ok) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.UNAVAILABLE,
                `OpenClaw requires working inference: ${inference.error}`,
              ),
            );
            return;
          }
          // The gateway surface must never install/restart its own daemon; the
          // engine's setup path honors this via surface: "gateway".
          const engine = new SystemAgentChatEngine({
            surface: "gateway",
            verifiedInference: inference.binding,
          });
          let welcome: string;
          try {
            if (params.welcomeVariant === "onboarding") {
              welcome = await buildOnboardingWelcome({ engine });
            } else {
              welcome = formatSystemAgentStartupMessage(await engine.loadOverview());
              engine.noteAssistantMessage(welcome);
            }
          } catch (error) {
            await engine.dispose().catch(() => undefined);
            if (!isSystemAgentInferenceUnavailableError(error)) {
              throw error;
            }
            respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error.message));
            return;
          }
          await evictOldestSession(sessions);
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
        let reply: Awaited<ReturnType<SystemAgentChatEngine["handle"]>>;
        try {
          reply = await session.engine.handle(params.message);
        } catch (error) {
          if (!isSystemAgentInferenceUnavailableError(error)) {
            throw error;
          }
          // A failed inference turn invalidates this conversation. Remove the
          // exact engine before cleanup so a retry must pass the live gate and
          // cannot resume partial proposal or CLI-session state.
          if (sessions.get(sessionId)?.engine === session.engine) {
            sessions.delete(sessionId);
          }
          try {
            await session.engine.dispose();
          } catch {
            // The inference error is authoritative; cleanup stays best-effort.
          }
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error.message));
          return;
        }
        // The TUI-only "open-tui" handoff becomes a client-visible "open-agent"
        // signal: the app should move the user to their normal agent chat.
        const action =
          reply.action === "open-tui"
            ? "open-agent"
            : reply.action === "open-setup"
              ? "none"
              : reply.action;
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
            ...(reply.sensitive === true ? { sensitive: true } : {}),
          },
          undefined,
        );
      });
    });
  },
};
