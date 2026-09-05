/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
// Integration proof for #137125: drives the PRODUCTION reset path through the
// real session capability (the shared /clear choke point) into the real lazy
// runtime singleton (forgetCriticalObserverTracker), then delivers a
// session.observer digest through the same singleton (handleCriticalObserverDigest)
// and asserts the resulting toast renders. This is the end-to-end app-shell
// flow the focused tracker unit tests do not cover: reset -> bootstrap hook ->
// runtime singleton forget -> observer event -> toast.
//
// Mirrors the bootstrap.ts:273 wiring (onSessionLifecycleReset -> lazy runtime
// forget) and the app-shell-gateway.ts:163 delivery (session.observer ->
// handleCriticalObserverDigest -> showCriticalSessionObserverNotice -> showToast).
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionCapability } from "../../lib/sessions/index.ts";
import {
  resolveUiConversationIdentity,
  type UiSessionDefaultsHost,
} from "../../lib/sessions/session-key.ts";
import * as criticalObserverRuntime from "./critical-observer-notice.runtime.ts";
import { resetCriticalObserverTracker } from "./critical-observer-notice.runtime.ts";

afterEach(() => {
  document.body.replaceChildren();
  resetCriticalObserverTracker();
});

const SESSION_KEY = "agent:main:other";
const SELECTED_SESSION_KEY = "agent:main:selected";

// Minimal connected gateway snapshot matching the SessionGateway contract the
// capability consumes: a connected client whose `sessions.reset` resolves.
// When simulateSend is true (default), the mock fires onSent before resetImpl,
// matching the real client's behavior after sender.send() succeeds. When false,
// onSent is not fired, simulating a before-send rejection (no socket).
function createConnectedGateway(resetImpl: () => Promise<unknown>, simulateSend = true) {
  const client = {
    request: vi.fn(async (method: string, _params?: unknown, options?: unknown) => {
      if (method === "sessions.reset") {
        if (simulateSend) {
          (options as { onSent?: () => void } | undefined)?.onSent?.();
        }
        await resetImpl();
        return {};
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return { sessions: [], defaults: null, revision: 1 };
      }
      throw new Error(`unexpected method: ${method}`);
    }),
  };
  return {
    snapshot: {
      client: client as never,
      phase: "connected" as const,
      hello: null,
      assistantAgentId: "main",
      sessionKey: SELECTED_SESSION_KEY,
    },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  };
}

function deliverObserverDigest(params: { headline: string; health: string; revision: number }) {
  // Same call app-shell-gateway.ts:163 makes on a session.observer event.
  criticalObserverRuntime.handleCriticalObserverDigest({
    payload: {
      sessionKey: SESSION_KEY,
      headline: params.headline,
      health: params.health,
      revision: params.revision,
    },
    selectedSessionKey: SELECTED_SESSION_KEY,
    // sessionHost: {} means no agent-list/main-session defaults — the
    // non-global session key `agent:main:other` is matched directly.
    sessionHost: {},
    sessions: [{ key: SESSION_KEY, label: "Other work", kind: "direct", updatedAt: null }],
    onOpen: vi.fn(),
  });
}

describe("reset -> runtime singleton forget -> observer toast (#137125 integration)", () => {
  it("retires the runtime singleton floor on /clear so a new lifecycle revision 1 announces the toast", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    // Bootstrap wiring (verbatim shape of bootstrap.ts:273): the reset hook
    // calls the lazy runtime forget on the document-lifetime singleton.
    const gateway = createConnectedGateway(async () => undefined);
    let hookFired = false;
    const sessions = createSessionCapability(
      gateway as never,
      { state: { selectedId: "main" }, subscribe: () => () => undefined },
      {
        onSessionLifecycleReset: (identity) => {
          hookFired = true;
          criticalObserverRuntime.forgetCriticalObserverTracker(identity);
        },
      },
    );

    // Pre-reset observer digest establishes the revision floor the issue
    // describes (rev 10 stuck) — toast renders and the floor is recorded.
    deliverObserverDigest({ headline: "Pre-reset stuck", health: "stuck", revision: 10 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Pre-reset stuck",
    );
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    // Without the fix: the floor of 10 is retained across reset, so the new
    // lifecycle's revision 1 is rejected as stale and the toast is silently
    // suppressed — exactly the bug #137125 reports. With the fix, the hook
    // retires the floor and revision 1 announces again.
    const result = await sessions.reset(SESSION_KEY, { agentId: undefined });
    expect(result).toBe("completed");
    expect(hookFired).toBe(true);

    deliverObserverDigest({ headline: "Post-reset stuck", health: "stuck", revision: 1 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Post-reset stuck",
    );

    sessions.dispose();
  });

  it("a different session keeps its revision floor across another session's reset", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    const KEPT_KEY = "agent:main:kept";
    const gateway = createConnectedGateway(async () => undefined);
    const sessions = createSessionCapability(
      gateway as never,
      { state: { selectedId: "main" }, subscribe: () => () => undefined },
      {
        onSessionLifecycleReset: (identity) => {
          criticalObserverRuntime.forgetCriticalObserverTracker(identity);
        },
      },
    );

    // Establish floors on both sessions.
    deliverObserverDigest({ headline: "Pre-reset other", health: "stuck", revision: 10 });
    criticalObserverRuntime.handleCriticalObserverDigest({
      payload: {
        sessionKey: KEPT_KEY,
        headline: "Pre-reset kept",
        health: "stuck",
        revision: 10,
      },
      selectedSessionKey: SELECTED_SESSION_KEY,
      sessionHost: {},
      sessions: [{ key: KEPT_KEY, label: "Kept", kind: "direct", updatedAt: null }],
      onOpen: vi.fn(),
    });
    await toastHost.updateComplete;
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;

    // Reset ONLY `other` — the kept session's floor must survive.
    await sessions.reset(SESSION_KEY, { agentId: undefined });

    // The reset session's new lifecycle revision 1 announces.
    deliverObserverDigest({ headline: "Post-reset other", health: "stuck", revision: 1 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Post-reset other",
    );
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;

    // The kept session's same revision 10 is deduplicated (floor retained) — no toast.
    criticalObserverRuntime.handleCriticalObserverDigest({
      payload: {
        sessionKey: KEPT_KEY,
        headline: "Replay kept",
        health: "stuck",
        revision: 10,
      },
      selectedSessionKey: SELECTED_SESSION_KEY,
      sessionHost: {},
      sessions: [{ key: KEPT_KEY, label: "Kept", kind: "direct", updatedAt: null }],
      onOpen: vi.fn(),
    });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    sessions.dispose();
  });

  it("retires the floor when a post-commit Gateway error returns ok:false", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    // A Gateway response error (ok:false) does not prove the reset was
    // uncommitted — the Gateway writes the new lifecycle before awaited hooks
    // and unbinding can fail and return ok:false. Since the request reached the
    // transport (onSent fired), the floor must be retired to avoid re-introducing
    // the silent revision-1 suppression the fix targets.
    const gatewayError = new GatewayProtocolRequestError({
      code: "UNAVAILABLE",
      message: "post-commit hook failed",
    });

    const gateway = createConnectedGateway(async () => {
      throw gatewayError;
    });
    let hookFired = false;
    const sessions = createSessionCapability(
      gateway as never,
      { state: { selectedId: "main" }, subscribe: () => () => undefined },
      {
        onSessionLifecycleReset: (identity) => {
          hookFired = true;
          criticalObserverRuntime.forgetCriticalObserverTracker(identity);
        },
      },
    );

    // Establish the revision floor (rev 10 stuck).
    deliverObserverDigest({ headline: "Pre-reset stuck", health: "stuck", revision: 10 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Pre-reset stuck",
    );
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;

    // Reset returns ok:false after the request was sent — hook must fire
    // because the lifecycle may have been replaced before the error.
    const result = await sessions.reset(SESSION_KEY, { agentId: undefined });
    expect(result).toBe("uncertain");
    expect(hookFired).toBe(true);

    // The floor was retired, so a replacement lifecycle revision 1 announces.
    deliverObserverDigest({ headline: "Post-commit stuck", health: "stuck", revision: 1 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Post-commit stuck",
    );

    sessions.dispose();
  });

  it("keeps the revision floor when reset fails before the request is sent (no socket)", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    // A local before-send rejection: the socket is unavailable so the request
    // never reaches the Gateway (onSent never fires, requestSent stays false).
    // The lifecycle was NOT replaced, so the floor must survive to deduplicate
    // the same revision.
    const gateway = createConnectedGateway(async () => {
      throw new Error("gateway not connected");
    }, false);
    let hookFired = false;
    const sessions = createSessionCapability(
      gateway as never,
      { state: { selectedId: "main" }, subscribe: () => () => undefined },
      {
        onSessionLifecycleReset: (identity) => {
          hookFired = true;
          criticalObserverRuntime.forgetCriticalObserverTracker(identity);
        },
      },
    );

    // Establish the revision floor (rev 10 stuck).
    deliverObserverDigest({ headline: "Pre-reset stuck", health: "stuck", revision: 10 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Other work — Pre-reset stuck",
    );
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;

    // Reset fails before the request is sent — hook must NOT fire.
    const result = await sessions.reset(SESSION_KEY, { agentId: undefined });
    expect(result).toBe("uncertain");
    expect(hookFired).toBe(false);

    // Same revision 10 is deduplicated (floor retained) — no duplicate toast.
    deliverObserverDigest({ headline: "Pre-reset stuck", health: "stuck", revision: 10 });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    sessions.dispose();
  });

  it("canonicalizes a non-default-agent global alias before retiring the floor (#137917)", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    // Configured global scope with a non-default agent: the Home route
    // retains `agent:work:main` (the alias), but the Gateway resets `global`
    // and observer digests arrive as `global` with `agentId: "work"`.
    const ALIAS_KEY = "agent:work:main";
    const CANONICAL_KEY = "global";
    const AGENT_ID = "work";
    const sessionHost = {
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "main" }, { id: "work" }],
      },
    };

    // Bootstrap wiring matching bootstrap.ts: resolve the canonical identity
    // before the RPC (resolveSessionResetIdentity) and forget on completion
    // (onSessionLifecycleReset). Capturing before the RPC is critical: if the
    // socket closes mid-reset, hello/agentsList are cleared before the
    // completion path runs, so resolving then would fail to map the alias.
    const gateway = createConnectedGateway(async () => undefined);
    let hookFired = false;
    const sessions = createSessionCapability(
      gateway as never,
      { state: { selectedId: AGENT_ID }, subscribe: () => () => undefined },
      {
        resolveSessionResetIdentity: (key, agentId) =>
          resolveUiConversationIdentity(sessionHost, key, agentId ?? undefined),
        onSessionLifecycleReset: (identity) => {
          hookFired = true;
          criticalObserverRuntime.forgetCriticalObserverTracker(identity);
        },
      },
    );

    // Pre-reset observer digest at revision 10 establishes the floor under
    // the canonical key `global:work` — toast renders.
    criticalObserverRuntime.handleCriticalObserverDigest({
      payload: {
        sessionKey: CANONICAL_KEY,
        agentId: AGENT_ID,
        headline: "Pre-reset stuck",
        health: "stuck",
        revision: 10,
      },
      selectedSessionKey: SELECTED_SESSION_KEY,
      sessionHost,
      sessions: [{ key: CANONICAL_KEY, label: "Work session", kind: "global", updatedAt: null }],
      onOpen: vi.fn(),
    });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Work session — Pre-reset stuck",
    );
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    // /clear passes the alias `agent:work:main` with `agentId: "work"`.
    // Without canonicalization: forget deletes `agent:work:main` (not stored),
    // leaving the `global:work` floor intact → revision 1 is suppressed.
    // With canonicalization: resolveUiConversationIdentity maps the alias to
    // `{ sessionKey: "global", agentId: "work" }` and forget deletes `global:work`.
    const result = await sessions.reset(ALIAS_KEY, { agentId: AGENT_ID });
    expect(result).toBe("completed");
    expect(hookFired).toBe(true);

    // Post-reset revision 1 must announce — the floor was retired under the
    // canonical key, not the alias.
    criticalObserverRuntime.handleCriticalObserverDigest({
      payload: {
        sessionKey: CANONICAL_KEY,
        agentId: AGENT_ID,
        headline: "Post-reset stuck",
        health: "stuck",
        revision: 1,
      },
      selectedSessionKey: SELECTED_SESSION_KEY,
      sessionHost,
      sessions: [{ key: CANONICAL_KEY, label: "Work session", kind: "global", updatedAt: null }],
      onOpen: vi.fn(),
    });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Work session — Post-reset stuck",
    );

    sessions.dispose();
  });

  // Regression for the disconnect completion path (ClawSweeper P2): if the
  // socket closes after the reset is sent but before its response arrives,
  // the client clears hello/agentsList on reconnect before the reset
  // continuation runs. Resolving identity at completion time would then fail
  // to map the alias to the canonical key, leaving the floor intact. Capturing
  // the canonical identity before the RPC ensures the completion path forgets
  // the right key regardless of disconnect state.
  it("uses the pre-RPC canonical identity when the socket disconnects mid-reset (#137917)", async () => {
    const toastHost = document.createElement("openclaw-toast-host");
    document.body.append(toastHost);

    const ALIAS_KEY = "agent:work:main";
    const CANONICAL_KEY = "global";
    const AGENT_ID = "work";
    // sessionHost with defaults — used to resolve the alias at capture time.
    const sessionHostWithDefaults = {
      agentsList: {
        defaultId: "main",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "main" }, { id: "work" }],
      },
    };
    // Cleared sessionHost — what the completion path would see if the socket
    // disconnected and hello/agentsList were cleared on reconnect.
    const clearedSessionHost: UiSessionDefaultsHost = {};

    let resolveCallCount = 0;
    let resolveHost: UiSessionDefaultsHost = sessionHostWithDefaults;

    // Gateway fires onSent (request reached transport), then simulates a
    // socket close by clearing the session host (as the client would on
    // reconnect), then rejects with a correlated Gateway error.
    const gatewayError = new GatewayProtocolRequestError({
      message: "socket closed",
      code: "UNAVAILABLE",
    });
    const gateway = createConnectedGateway(async () => {
      // Socket closed mid-RPC: the client clears hello/agentsList before the
      // reset continuation runs. If onSessionLifecycleReset re-resolved now,
      // it would see cleared defaults and fail to map the alias.
      resolveHost = clearedSessionHost;
      throw gatewayError;
    });
    const sessions = createSessionCapability(
      gateway as never,
      { state: { selectedId: AGENT_ID }, subscribe: () => () => undefined },
      {
        // resolveSessionResetIdentity is called before the RPC; it sees the
        // full sessionHost with defaults and maps the alias to global:work.
        resolveSessionResetIdentity: (key, agentId) => {
          resolveCallCount++;
          return resolveUiConversationIdentity(resolveHost, key, agentId ?? undefined);
        },
        onSessionLifecycleReset: (identity) => {
          // The completion path receives the pre-captured canonical identity,
          // NOT a re-resolution against the (now-cleared) sessionHost.
          criticalObserverRuntime.forgetCriticalObserverTracker(identity);
        },
      },
    );

    // Establish the floor under the canonical key global:work.
    criticalObserverRuntime.handleCriticalObserverDigest({
      payload: {
        sessionKey: CANONICAL_KEY,
        agentId: AGENT_ID,
        headline: "Pre-reset stuck",
        health: "stuck",
        revision: 10,
      },
      selectedSessionKey: SELECTED_SESSION_KEY,
      sessionHost: sessionHostWithDefaults,
      sessions: [{ key: CANONICAL_KEY, label: "Work session", kind: "global", updatedAt: null }],
      onOpen: vi.fn(),
    });
    await toastHost.updateComplete;
    toastHost.querySelector<HTMLButtonElement>(".app-toast__action")?.click();
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast")).toBeNull();

    // The socket closes inside the RPC (resetImpl clears resolveHost then
    // rejects). resolveSessionResetIdentity was already called before the RPC
    // with the full defaults, so the completion path uses the captured identity.
    const result = await sessions.reset(ALIAS_KEY, { agentId: AGENT_ID });
    expect(result).toBe("uncertain");
    // resolveSessionResetIdentity was called exactly once, before the RPC.
    expect(resolveCallCount).toBe(1);

    // Post-reset revision 1 must announce — the floor was retired under the
    // canonical key global:work, not the alias agent:work:main. If the
    // completion path had re-resolved against cleared defaults, it would have
    // forgotten agent:work:main (not stored) and the floor would persist.
    criticalObserverRuntime.handleCriticalObserverDigest({
      payload: {
        sessionKey: CANONICAL_KEY,
        agentId: AGENT_ID,
        headline: "Post-reset stuck",
        health: "stuck",
        revision: 1,
      },
      selectedSessionKey: SELECTED_SESSION_KEY,
      sessionHost: sessionHostWithDefaults,
      sessions: [{ key: CANONICAL_KEY, label: "Work session", kind: "global", updatedAt: null }],
      onOpen: vi.fn(),
    });
    await toastHost.updateComplete;
    expect(toastHost.querySelector(".app-toast__message")?.textContent).toContain(
      "Work session — Post-reset stuck",
    );

    sessions.dispose();
  });
});
