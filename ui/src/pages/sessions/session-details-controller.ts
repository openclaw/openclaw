import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { GatewaySessionRow } from "../../api/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type {
  SessionCapability,
  SessionRowObservation,
} from "../../lib/sessions/session-capability.ts";

type DetailScope = { sessions: Pick<SessionCapability, "observeRow" | "describe"> };

/** The expanded view holds a descriptor; the session capability owns its row facts. */
export class SessionDetailsController<Scope extends DetailScope> implements ReactiveController {
  loading = false;
  error: string | null = null;
  private binding?: { matches: () => boolean; dispose: () => void };

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly options: {
      captureScope: () => Scope | null;
      isCurrent: (scope: Scope) => boolean;
      row: () => GatewaySessionRow | undefined;
      agentId: (row: GatewaySessionRow, scope: Scope) => string;
    },
  ) {
    host.addController(this);
  }

  hostDisconnected() {
    this.reset();
  }

  reset() {
    this.binding?.dispose();
    this.binding = undefined;
    this.loading = false;
    this.error = null;
  }

  synchronize() {
    if (this.binding?.matches()) {
      return;
    }
    this.reset();
    const row = this.options.row();
    const scope = this.options.captureScope();
    if (!row || !scope) {
      return;
    }
    const { key, sessionId } = row;
    const agentId = this.options.agentId(row, scope);
    // Registration may notify before the observation handle is returned.
    let observation: SessionRowObservation | null = null;
    let pending = false;
    const binding = {
      matches: () => {
        const selected = this.options.row();
        return (
          this.options.isCurrent(scope) &&
          observation?.isCurrent() !== false &&
          selected?.key === key &&
          selected.sessionId === sessionId
        );
      },
      dispose: () => observation?.dispose(),
    };
    const current = () => this.binding === binding && binding.matches();
    const refresh = async () => {
      if (pending || !current()) {
        return;
      }
      pending = true;
      this.loading = true;
      this.error = null;
      this.host.requestUpdate();
      try {
        while (current() && observation?.isCurrent()) {
          const reconcile = observation.captureReconcile();
          const { session } = await scope.sessions.describe({ key, agentId });
          if (!current() || reconcile(session ?? undefined).status !== "invalidated") {
            break;
          }
        }
      } catch (error) {
        if (current()) {
          this.error = formatUiError(error);
        }
      } finally {
        pending = false;
        if (current()) {
          this.loading = false;
          this.host.requestUpdate();
        }
      }
    };
    this.binding = binding;
    observation = scope.sessions.observeRow(
      { key, agentId },
      () => {
        if (current()) {
          this.host.requestUpdate();
        }
      },
      { onInvalidate: () => void refresh() },
    );
    if (row.rowMode === "compact") {
      void refresh();
    }
  }
}
