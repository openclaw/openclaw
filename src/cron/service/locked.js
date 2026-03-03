const storeLocks = new Map();
const resolveChain = (promise) => promise.then(() => undefined, () => undefined);
export async function locked(state, fn) {
    const storePath = state.deps.storePath;
    const storeOp = storeLocks.get(storePath) ?? Promise.resolve();
    const next = Promise.all([resolveChain(state.op), resolveChain(storeOp)]).then(fn);
    // Keep the chain alive even when the operation fails.
    const keepAlive = resolveChain(next);
    state.op = keepAlive;
    storeLocks.set(storePath, keepAlive);
    return (await next);
}
