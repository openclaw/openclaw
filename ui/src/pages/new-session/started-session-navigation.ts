import { selectApplicationSession } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { gatewayPresentationScope } from "../../app/gateway-presentation-scope.ts";
import { navigateWithRouteTransition } from "../../app/route-transition.ts";
import { prepareSessionNavigationHandoff } from "../../lib/sessions/navigation-handoff.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import { normalizeAgentId } from "../../lib/sessions/session-key.ts";
import { buildLocalUserMessage } from "../chat/user-message-content.ts";

type StartedSession = {
  client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
  hello: ApplicationContext["gateway"]["snapshot"]["hello"];
  key: string;
  agentId: string;
};

/** A committed create is retried as navigation, never as a second create. */
export class StartedSessionNavigation {
  current: StartedSession | null = null;
  private submitted: {
    context: ApplicationContext;
    message: NonNullable<ReturnType<typeof buildLocalUserMessage>>;
    key: string;
    agentId: string;
    error?: string;
    canDisplay: () => boolean;
  } | null = null;

  captureSubmission(
    context: ApplicationContext,
    agentId: string,
    message: ReturnType<typeof buildLocalUserMessage>,
    isCurrent: () => boolean = () => true,
  ) {
    const gateway = context.gateway;
    const owner = gatewayPresentationScope(gateway);
    const gatewayUrl = gateway.connection.gatewayUrl;
    let recoveryScope =
      gateway.snapshot.hello?.auth?.recoveryScope ??
      (gateway.snapshot.client?.recoveryScopeReady
        ? gateway.snapshot.client.recoveryScope
        : undefined);
    const canDisplay = () => {
      const snapshot = gateway.snapshot;
      const scope =
        snapshot.hello?.auth?.recoveryScope ??
        (snapshot.client?.recoveryScopeReady ? snapshot.client.recoveryScope : undefined);
      recoveryScope ??= scope;
      return (
        gatewayPresentationScope(gateway) === owner &&
        gateway.connection.gatewayUrl === gatewayUrl &&
        (!scope || scope === recoveryScope)
      );
    };
    return (key: string, error?: string) => {
      if (message && isCurrent() && canDisplay()) {
        this.submitted = { context, message, key, agentId, error, canDisplay };
      }
    };
  }

  submission(context: ApplicationContext | undefined) {
    const submitted = this.submitted;
    return submitted && submitted.context === context && submitted.canDisplay() ? submitted : null;
  }

  messageForTurn(
    context: ApplicationContext,
    agentId: string,
    turn: Parameters<typeof buildLocalUserMessage>[0],
  ) {
    return (
      buildLocalUserMessage(turn, "available") ??
      (this.isCurrent(context, agentId) ? (this.submission(context)?.message ?? null) : null)
    );
  }

  async openSubmission(
    context: ApplicationContext | undefined,
    submission: ReturnType<StartedSessionNavigation["submission"]>,
    presentation: {
      capture: () => () => boolean;
      publish: (message: ReturnType<typeof buildLocalUserMessage>, error?: string | null) => void;
    },
  ) {
    const client = context?.gateway.snapshot.client;
    if (
      !submission ||
      !context ||
      !client ||
      context.gateway.snapshot.phase !== "connected" ||
      this.submission(context) !== submission
    ) {
      return;
    }
    const isCurrent = presentation.capture();
    presentation.publish(submission.message, null);
    let failure: string | undefined;
    try {
      await this.navigate(context, { client, key: submission.key, agentId: submission.agentId });
    } catch (error) {
      if (isCurrent() && submission.canDisplay()) {
        failure = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (isCurrent()) {
        presentation.publish(null, failure);
      }
    }
  }

  clearSubmission() {
    this.submitted = null;
  }

  isCurrent(context: ApplicationContext | undefined, agentId: string): boolean {
    const started = this.current;
    const snapshot = context?.gateway.snapshot;
    return Boolean(
      started &&
      snapshot?.phase === "connected" &&
      snapshot.client === started.client &&
      snapshot.hello === started.hello &&
      snapshot.sessionKey === started.key &&
      normalizeAgentId(agentId) === started.agentId,
    );
  }

  async navigate(
    context: ApplicationContext,
    started: Omit<StartedSession, "hello">,
    commitRoute?: () => boolean,
  ): Promise<void> {
    const current = { ...started, hello: context.gateway.snapshot.hello };
    this.current = current;
    selectApplicationSession({
      selection: context.agentSelection,
      gateway: context.gateway,
      sessionKey: started.key,
      agentId: started.agentId,
    });
    const options = sessionNavigationTarget({
      context,
      face: "chat",
      sessionKey: started.key,
      agentId: started.agentId,
      focusComposer: true,
      navigationKey: started.key,
    }).options;
    await navigateWithRouteTransition({
      document,
      from: "new-session",
      to: "chat",
      router: context.router,
      signal: context.lifecycleAbortSignal,
      prefersReducedMotion:
        globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
      navigate: () => {
        if (this.current !== current || !this.isCurrent(context, started.agentId)) {
          throw new DOMException("Session navigation interrupted", "AbortError");
        }
        // Release a transient start only at the synchronous committed-navigation
        // boundary, after the create owner validates pending-route readiness.
        if (commitRoute && !commitRoute()) {
          throw new DOMException("Session navigation superseded", "AbortError");
        }
        // Carry the confirmed key through the same connection's short route;
        // neither the background roster nor another lookup needs to finish.
        prepareSessionNavigationHandoff(context.gateway, options.pathname, started.key);
        return context.navigateAndWait("chat", options);
      },
    });
    if (this.current === current) {
      this.current = null;
    }
  }
}
