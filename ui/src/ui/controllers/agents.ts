export async function loadAgents(state: AgentsState) {
  if (!state.client || !state.connected) {
    return;
  }
  if (state.agentsLoading) {
    return;
  }
  state.agentsLoading = true;
  state.agentsError = null;
  let retryCount = 0;
  const maxRetries = 3;
  while (retryCount <= maxRetries) {
    try {
      const res = await state.client.request<AgentsListResult>("agents.list", {});
      if (res) {
        state.agentsList = res;
        const selected = state.agentsSelectedId;
        const known = res.agents.some((entry) => entry.id === selected);
        if (!selected || !known) {
          state.agentsSelectedId = res.defaultId ?? res.agents[0]?.id ?? null;
        }
      }
      break;
    } catch (err) {
      if (isMissingOperatorReadScopeError(err)) {
        state.agentsList = null;
        state.agentsError = formatMissingOperatorReadScopeMessage("agent list");
      } else {
        state.agentsError = String(err);
      }
      retryCount++;
      if (retryCount > maxRetries) {
        throw new Error('Exceeded maximum retry attempts');
      }
    }
  } finally {
    state.agentsLoading = false;
  }
}