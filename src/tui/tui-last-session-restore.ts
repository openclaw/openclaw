import { normalizeAgentId } from "../routing/session-key.js";
import type { TuiBackend } from "./tui-backend.js";
import { readTuiLastSessionKey, resolveRememberedTuiSessionKey } from "./tui-last-session.js";
import type { TuiStateAccess } from "./tui-types.js";

/** Keeps startup preview and confirmed restoration on the same selected conversation. */
export function createTuiLastSessionRestore(params: {
  explicitSession: boolean;
  state: Pick<TuiStateAccess, "currentAgentId" | "currentSessionKey" | "sessionGeneration">;
  buildScopeKey: () => string;
  resolveSelection: (raw: string, agentId: string) => { key: string; agentId: string };
  describeSession: TuiBackend["describeSession"];
  ownsConnection: (generation: number) => boolean;
}) {
  const { state } = params;
  let applied = params.explicitSession;
  let provisionalSessionKey: string | null = null;
  const resolveCandidate = async () => {
    const agentId = state.currentAgentId;
    const remembered = await readTuiLastSessionKey({ scopeKey: params.buildScopeKey() });
    if (!remembered) {
      return null;
    }
    const selection = params.resolveSelection(remembered, agentId);
    return selection.key !== state.currentSessionKey &&
      normalizeAgentId(selection.agentId) === agentId
      ? selection.key
      : null;
  };
  return {
    get provisionalSessionKey() {
      return provisionalSessionKey;
    },
    async preview(): Promise<void> {
      if (applied) {
        return;
      }
      // The terminal and its startup-error path are not active until this best-effort preview finishes.
      try {
        provisionalSessionKey = await resolveCandidate();
      } catch {
        provisionalSessionKey = null;
      }
    },
    supersede(): void {
      applied = true;
      provisionalSessionKey = null;
    },
    async restore(connectionGeneration: number): Promise<void> {
      if (applied) {
        return;
      }
      const { currentAgentId, currentSessionKey, sessionGeneration } = state;
      const isCurrent = () => {
        if (applied || !params.ownsConnection(connectionGeneration)) {
          return false;
        }
        if (
          currentAgentId !== state.currentAgentId ||
          currentSessionKey !== state.currentSessionKey ||
          sessionGeneration !== state.sessionGeneration
        ) {
          provisionalSessionKey = null;
          applied = true;
          return false;
        }
        return true;
      };
      const rememberedKey = await resolveCandidate().catch((error: unknown) => {
        if (isCurrent()) {
          throw error;
        }
        return null;
      });
      if (!isCurrent()) {
        return;
      }
      if (!rememberedKey) {
        provisionalSessionKey = null;
        applied = true;
        return;
      }
      const description = await params
        .describeSession({ sessionKey: rememberedKey, agentId: currentAgentId })
        .catch(() => null);
      if (!isCurrent()) {
        return;
      }
      provisionalSessionKey = null;
      if (!description) {
        return;
      }
      applied = true;
      const restored = resolveRememberedTuiSessionKey({
        rememberedKey,
        currentAgentId,
        sessions:
          description.session && description.session.key !== "unknown" ? [description.session] : [],
      });
      if (restored && restored !== state.currentSessionKey) {
        state.currentSessionKey = restored;
      }
    },
  };
}
