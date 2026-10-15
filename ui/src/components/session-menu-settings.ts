import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import type { SolidControllerHost } from "../lit/solid-controller-host.ts";
import {
  selectSessionCommunication,
  type SessionCommunicationMenuAction,
} from "./session-communication-options.ts";
import { SessionDetailsController } from "./session-details-controller.ts";

type SessionMenuSettingsOptions = {
  context: () => ApplicationContext | undefined;
  readState: () => {
    session: Pick<GatewaySessionRow, "communication" | "effectiveCommunication"> & {
      target?: { key: string; agentId?: string };
      sessionId: string | null;
    };
    selectionCount: number;
  };
  runAction: (action: SessionCommunicationMenuAction) => void;
};

/** Composes session settings around capability-owned metadata and sparse communication edits. */
export class SessionMenuSettings {
  private settingsActive = false;
  private readonly settingsDetails;
  communicationState() {
    const state = this.options.readState();
    return { ...state, session: this.settingsDetails.row ?? state.session };
  }

  constructor(
    host: SolidControllerHost,
    private readonly options: SessionMenuSettingsOptions,
  ) {
    this.settingsDetails = new SessionDetailsController(() => host.requestUpdate(), {
      captureScope: () => {
        const context = this.options.context();
        const connection = context?.sessions.captureConnectionScope();
        return context && connection ? { context, sessions: context.sessions, connection } : null;
      },
      isCurrent: (scope) =>
        this.options.context() === scope.context &&
        this.options.context()?.sessions === scope.sessions &&
        scope.sessions.isConnectionScopeCurrent(scope.connection),
      row: () => {
        const { session, selectionCount } = this.options.readState();
        return this.settingsActive && selectionCount === 1 && session.target
          ? {
              key: session.target.key,
              sessionId: session.sessionId ?? undefined,
              rowMode: "compact" as const,
            }
          : undefined;
      },
      agentId: (row, scope) =>
        this.options.readState().session.target?.agentId ??
        parseAgentSessionKey(row.key)?.agentId ??
        scope.context.agentSelection.state.selectedId ??
        "main",
    });

    host.addController({
      hostDisconnected: () => this.settingsDetails.reset(),
      hostUpdate: () => {
        if (this.settingsActive) {
          this.settingsDetails.synchronize();
        }
      },
    });
  }

  get error(): string | null {
    return this.settingsDetails.error;
  }

  get communicationAvailable(): boolean {
    return Boolean(this.communicationState().session.effectiveCommunication);
  }

  open(): void {
    this.settingsActive = true;
    this.settingsDetails.synchronize();
  }

  readonly close = () => {
    this.settingsActive = false;
    this.settingsDetails.reset();
  };

  handleSelect(value: string): boolean {
    if (value === "reload-settings") {
      this.settingsDetails.reset();
      this.settingsDetails.synchronize();
      return true;
    }
    return selectSessionCommunication(value, this.options.runAction);
  }
}
