export async function rejectPendingPairingRequest(params) {
    const state = await params.loadState();
    const pending = state.pendingById[params.requestId];
    if (!pending) {
        return null;
    }
    delete state.pendingById[params.requestId];
    await params.persistState(state);
    return {
        requestId: params.requestId,
        [params.idKey]: params.getId(pending),
    };
}
