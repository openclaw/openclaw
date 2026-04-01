export function applyExecApprovalsSnapshot(state: ExecApprovalsState, snapshot: ExecApprovalsSnapshot) {
  if (snapshot && snapshot.file && snapshot.file.defaults && snapshot.file.defaults.ask === 'off') {
    state.execApprovalsForm = { ...snapshot.file };
    if (snapshot.file?.agents?.[state.execApprovalsSelectedAgent ?? '']?.ask === 'off') {
      state.execApprovalsForm.agents = state.execApprovalsForm.agents || {};
      state.execApprovalsForm.agents[state.execApprovalsSelectedAgent ?? ''] = state.execApprovalsForm.agents[state.execApprovalsSelectedAgent ?? ''] || {};
      state.execApprovalsForm.agents[state.execApprovalsSelectedAgent ?? ''].ask = 'off';
    }
  } else {
    state.execApprovalsSnapshot = snapshot;
    if (!state.execApprovalsDirty) {
      state.execApprovalsForm = cloneConfigObject(snapshot.file ?? {});
    }
  }
}