// In-process registry for loopback-only bridge servers that require auth, but
// are addressed via dynamic ephemeral ports (e.g. sandbox browser bridge).
const authByPort = new Map();
export function setBridgeAuthForPort(port, auth) {
    if (!Number.isFinite(port) || port <= 0) {
        return;
    }
    const token = typeof auth.token === "string" ? auth.token.trim() : "";
    const password = typeof auth.password === "string" ? auth.password.trim() : "";
    authByPort.set(port, {
        token: token || undefined,
        password: password || undefined,
    });
}
export function getBridgeAuthForPort(port) {
    if (!Number.isFinite(port) || port <= 0) {
        return undefined;
    }
    return authByPort.get(port);
}
export function deleteBridgeAuthForPort(port) {
    if (!Number.isFinite(port) || port <= 0) {
        return;
    }
    authByPort.delete(port);
}
