import { createSignal, onCleanup } from "solid-js";
import type { GatewaySessionRow } from "../api/types.ts";
import { formatUiError } from "../lib/format-error.ts";
import type {
  SessionCapability,
  SessionRowObservation,
} from "../lib/sessions/session-capability.ts";

type DetailScope = { sessions: Pick<SessionCapability, "observeRow" | "describe"> };
type DetailRow = Pick<GatewaySessionRow, "key" | "sessionId" | "rowMode" | "agentId">;
type DetailRequestState = { loading: boolean; error: string | null };
type DetailBinding = {
  matches: () => boolean;
  dispose: () => void;
  row: () => GatewaySessionRow | null;
};

/** The expanded view holds a descriptor; the session capability owns its row facts. */
export function createSessionDetails<Scope extends DetailScope>(options: {
  captureScope: () => Scope | null;
  isCurrent: (scope: Scope) => boolean;
  row: () => DetailRow | undefined;
  agentId: (row: DetailRow, scope: Scope) => string;
}) {
  const [state, setState] = createSignal<DetailRequestState>({ loading: false, error: null });
  const [rowRevision, setRowRevision] = createSignal(0);
  const rowChanged = () => setRowRevision((value) => value + 1);
  let loading = false;
  let activeBinding: DetailBinding | undefined;

  const release = () => {
    activeBinding?.dispose();
    activeBinding = undefined;
    loading = false;
  };
  const reset = () => {
    release();
    setState({ loading: false, error: null });
    rowChanged();
  };
  onCleanup(release);

  function synchronize() {
    if (activeBinding?.matches()) {
      return;
    }
    reset();
    const row = options.row();
    const scope = row && options.captureScope();
    if (!row || !scope) {
      return;
    }
    const { key, sessionId } = row;
    const agentId = options.agentId(row, scope);
    // Registration may notify before the observation handle is returned.
    let observation: SessionRowObservation | null = null;
    const binding = {
      matches: () => {
        const selected = options.row();
        return (
          options.isCurrent(scope) &&
          observation?.isCurrent() !== false &&
          selected?.key === key &&
          selected.sessionId === sessionId
        );
      },
      dispose: () => observation?.dispose(),
      row: () =>
        observation?.row && observation.row.sessionId === sessionId ? observation.row : null,
    };
    const current = () => activeBinding === binding && binding.matches();
    const refresh = async () => {
      if (loading || !current()) {
        return;
      }
      loading = true;
      setState({ loading: true, error: null });
      let error: string | null = null;
      try {
        if (observation?.isCurrent()) {
          const reconcile = observation.captureReconcile();
          const { session } = await scope.sessions.describe({ key, agentId });
          if (current()) {
            reconcile(session ?? undefined);
          }
        }
      } catch (failure) {
        error = formatUiError(failure);
      }
      if (current()) {
        loading = false;
        setState({ loading: false, error });
      }
    };
    activeBinding = binding;
    observation = scope.sessions.observeRow(
      { key, agentId },
      () => {
        if (current()) {
          rowChanged();
        }
      },
      { onInvalidate: () => void refresh() },
    );
    rowChanged();
    if (row.rowMode) {
      void refresh();
    }
  }
  return {
    error: () => state().error,
    loading: () => state().loading,
    reset,
    synchronize,
    row() {
      rowRevision();
      return activeBinding?.matches() ? activeBinding.row() : null;
    },
  };
}
