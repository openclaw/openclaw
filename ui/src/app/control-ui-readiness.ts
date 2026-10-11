import type { RouteLocation, RouterState } from "@openclaw/uirouter";
import type { AgentsListResult, SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { AgentSelectionCapability } from "./agent-selection.ts";
import type { ApplicationGateway } from "./gateway.ts";

type ReadinessNavigationOptions = Partial<Pick<RouteLocation, "pathname" | "search" | "hash">>;

// Keep automation's type graph independent of bootstrap and rendered route modules.
type ReadinessRuntime = {
  readonly context: {
    readonly basePath: string;
    readonly gateway: Pick<ApplicationGateway, "connectionRevision" | "snapshot" | "subscribe">;
    readonly sessions: {
      readonly canonicalListRevision: number;
      readonly state: {
        result: SessionsListResult | null;
        loading: boolean;
        resultCached?: boolean;
      };
      subscribe: (listener: () => void) => () => void;
    };
    readonly agents: {
      readonly state: {
        agentsError: string | null;
        agentsList: AgentsListResult | null;
        agentsLoading: boolean;
        connected: boolean;
      };
    };
    readonly agentSelection: Pick<AgentSelectionCapability, "state">;
    readonly navigate: (routeId: RouteId, options?: ReadinessNavigationOptions) => void;
  };
  readonly router: {
    getState: () => Pick<
      RouterState<RouteId>,
      "status" | "matches" | "pendingMatches" | "resolvedLocation"
    >;
    subscribe: (listener: () => void) => () => void;
  };
};

export type ControlUiCommittedPresentation = {
  kind: "loading" | "login" | "standalone" | "shell";
  navigationVisible: boolean;
  sessionKey?: string;
  terminalActivationReady?: boolean;
};

/** The outlet owns retirement and whether its current destination has committed. */
export interface ControlUiReadinessOutlet extends HTMLElement {
  readonly presentationSettled: boolean;
  settlePresentation(): Promise<boolean>;
}

/**
 * The browser automation contract is window.openclawControlUi. snapshot contains
 * admitted application facts; diagnostics returns data, never runtime handles.
 * data-openclaw-ready identifies the settled generation and is removed as soon
 * as its inputs change. Renderer adapters call invalidate before updating and
 * supply settlePresentation; consumers never await a renderer-specific promise.
 */
export class ControlUiReadiness {
  private generation = 0;
  private committedGeneration = -1;
  private rootCommitted = false;
  private presentation: ControlUiCommittedPresentation | null = null;
  private runtime: ReadinessRuntime | undefined;
  private settlePresentation: (() => Promise<ControlUiCommittedPresentation>) | undefined;
  private cleanups: Array<() => void> = [];
  private settlement: object | undefined;
  private rosterFloor = 0;
  private connectionRevision = -1;
  private connectionClient: object | null = null;
  private settlementError: string | null = null;

  constructor(private readonly root: HTMLElement) {}

  readonly hook = {
    snapshot: () => this.snapshot,
    diagnostics: () => this.diagnostics(),
    navigate: (routeId: RouteId, options?: ReadinessNavigationOptions) => {
      if (!this.runtime) {
        throw new Error("Control UI is disconnected");
      }
      this.runtime.context.navigate(routeId, options);
    },
  };

  connect(
    runtime: ReadinessRuntime,
    settlePresentation: () => Promise<ControlUiCommittedPresentation>,
  ): void {
    this.disconnect();
    this.runtime = runtime;
    this.settlePresentation = settlePresentation;
    this.connectionRevision = runtime.context.gateway.connectionRevision;
    this.connectionClient = runtime.context.gateway.snapshot.client;
    this.rosterFloor = 0;
    const gatewayChanged = () => {
      const { gateway, sessions } = runtime.context;
      if (
        gateway.connectionRevision !== this.connectionRevision ||
        gateway.snapshot.client !== this.connectionClient ||
        gateway.snapshot.phase !== "connected"
      ) {
        this.rosterFloor = sessions.canonicalListRevision;
        this.connectionRevision = gateway.connectionRevision;
        this.connectionClient = gateway.snapshot.client;
      }
      this.invalidate();
    };
    this.cleanups = [
      runtime.context.gateway.subscribe(gatewayChanged),
      runtime.context.sessions.subscribe(() => this.invalidate()),
      runtime.router.subscribe(() => this.invalidate()),
    ];
    const window = this.root.ownerDocument.defaultView;
    if (window) {
      Object.defineProperty(window, "openclawControlUi", {
        configurable: true,
        writable: true,
        value: this.hook,
      });
    }
    this.invalidate();
  }

  disconnect(): void {
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
    const window = this.root.ownerDocument.defaultView;
    if (window?.openclawControlUi === this.hook) {
      delete window.openclawControlUi;
    }
    this.runtime = undefined;
    this.settlement = undefined;
    this.settlePresentation = undefined;
    this.presentation = null;
    this.rootCommitted = false;
    this.invalidate();
  }

  invalidateRoot(): void {
    this.rootCommitted = false;
    this.invalidate();
  }

  commitRoot(): void {
    this.rootCommitted = true;
    this.invalidate();
  }

  invalidate(): void {
    this.generation += 1;
    this.settlementError = null;
    this.root.removeAttribute("data-openclaw-ready");
    if (!this.settlement && this.runtime) {
      void this.settle();
    }
  }

  private async settle(): Promise<void> {
    const settlement = {};
    this.settlement = settlement;
    try {
      while (this.settlement === settlement && this.runtime && this.settlePresentation) {
        const runtime = this.runtime;
        const generation = this.generation;
        let presentation: ControlUiCommittedPresentation;
        try {
          presentation = await this.settlePresentation();
        } catch (error) {
          if (this.settlement !== settlement) {
            return;
          }
          if (runtime !== this.runtime || generation !== this.generation) {
            continue;
          }
          this.settlementError = String(error);
          break;
        }
        if (this.settlement !== settlement) {
          return;
        }
        if (runtime !== this.runtime || generation !== this.generation) {
          continue;
        }
        this.presentation = presentation;
        this.committedGeneration = generation;
        if (this.snapshot.ready) {
          this.root.setAttribute("data-openclaw-ready", String(generation));
        }
        break;
      }
    } finally {
      if (this.settlement === settlement) {
        this.settlement = undefined;
      }
    }
  }

  private get snapshot() {
    const context = this.runtime?.context;
    const state = context?.sessions.state;
    const route = this.runtime?.router.getState();
    const gatewayPhase = context?.gateway.snapshot.phase ?? null;
    const routeReady = Boolean(
      this.committedGeneration === this.generation &&
      this.presentation?.kind === "shell" &&
      route &&
      route.status !== "loading" &&
      route.status !== "idle" &&
      route.pendingMatches.length === 0,
    );
    const rosterReady = Boolean(
      context &&
      context.sessions.canonicalListRevision > this.rosterFloor &&
      state?.result &&
      !state.loading &&
      !state.resultCached,
    );
    const recovery =
      gatewayPhase === "reconnecting" ||
      gatewayPhase === "offline" ||
      gatewayPhase === "reload-required";
    return {
      generation: this.generation,
      booted: this.rootCommitted,
      gatewayPhase,
      routeReady,
      rosterReady,
      ready:
        this.rootCommitted &&
        this.committedGeneration === this.generation &&
        (recovery ||
          this.presentation?.kind === "login" ||
          this.presentation?.kind === "standalone" ||
          (this.presentation?.kind === "shell" &&
            routeReady &&
            (!this.presentation.navigationVisible || rosterReady))),
      basePath: context?.basePath ?? "",
      sessionKey: this.presentation?.sessionKey ?? null,
      route: route
        ? {
            status: route.status,
            resolvedLocation: route.resolvedLocation,
            matches: route.matches.map(({ routeId }) => ({ routeId })),
            pendingMatches: route.pendingMatches.map(({ routeId }) => ({ routeId })),
          }
        : null,
      terminalActivationReady:
        this.committedGeneration === this.generation &&
        this.presentation?.terminalActivationReady === true,
    };
  }

  private diagnostics() {
    const context = this.runtime?.context;
    const agents = context?.agents.state;
    return {
      agentSelection: context?.agentSelection.state ?? null,
      gateway: {
        assistantAgentId: context?.gateway.snapshot.assistantAgentId ?? null,
        phase: context?.gateway.snapshot.phase ?? null,
      },
      roster: {
        agentsError: agents?.agentsError ?? null,
        agentsList: agents?.agentsList ?? null,
        agentsLoading: agents?.agentsLoading ?? null,
        connected: agents?.connected ?? null,
      },
      router: this.snapshot.route,
      settlementError: this.settlementError,
    };
  }
}

declare global {
  interface Window {
    openclawControlUi?: ControlUiReadiness["hook"];
  }
}
