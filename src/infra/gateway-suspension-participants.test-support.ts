// Clears the suspension participant registry between tests.
//
// The registry keeps its state in a global singleton, so this resolves the same
// slot instead of making the production module export a test-only reset seam.
// Importing the registry first guarantees the slot exists and is fully shaped.
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  setGatewayPluginSuspensionParticipants,
  type GatewaySuspensionParticipant,
} from "./gateway-suspension-participants.js";

type ClearableParticipantState = {
  prepared: { clear: () => void };
  pluginParticipants: readonly GatewaySuspensionParticipant[];
};

export function resetGatewaySuspensionParticipantsForTest(): void {
  const state = resolveGlobalSingleton(
    Symbol.for("openclaw.gatewaySuspensionParticipantState"),
    (): ClearableParticipantState => ({
      prepared: new Map(),
      pluginParticipants: [],
    }),
  );
  state.prepared.clear();
  state.pluginParticipants = [];
}

/** Install a queue through the same publication boundary used by the registry. */
export function registerGatewaySuspensionParticipant(
  participant: GatewaySuspensionParticipant,
): () => void {
  const state = resolveGlobalSingleton(
    Symbol.for("openclaw.gatewaySuspensionParticipantState"),
    (): ClearableParticipantState => ({ prepared: new Map(), pluginParticipants: [] }),
  );
  setGatewayPluginSuspensionParticipants([
    ...state.pluginParticipants.filter((entry) => entry.id !== participant.id),
    participant,
  ]);
  return () =>
    setGatewayPluginSuspensionParticipants(
      state.pluginParticipants.filter((entry) => entry !== participant),
    );
}
