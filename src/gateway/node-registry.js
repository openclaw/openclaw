import { randomUUID } from "node:crypto";
export class NodeRegistry {
    nodesById = new Map();
    nodesByConn = new Map();
    pendingInvokes = new Map();
    register(client, opts) {
        const connect = client.connect;
        const nodeId = connect.device?.id ?? connect.client.id;
        const caps = Array.isArray(connect.caps) ? connect.caps : [];
        const commands = Array.isArray(connect.commands)
            ? (connect.commands ?? [])
            : [];
        const permissions = typeof connect.permissions === "object"
            ? (connect.permissions ?? undefined)
            : undefined;
        const pathEnv = typeof connect.pathEnv === "string"
            ? connect.pathEnv
            : undefined;
        const session = {
            nodeId,
            connId: client.connId,
            client,
            displayName: connect.client.displayName,
            platform: connect.client.platform,
            version: connect.client.version,
            coreVersion: connect.coreVersion,
            uiVersion: connect.uiVersion,
            deviceFamily: connect.client.deviceFamily,
            modelIdentifier: connect.client.modelIdentifier,
            remoteIp: opts.remoteIp,
            caps,
            commands,
            permissions,
            pathEnv,
            connectedAtMs: Date.now(),
        };
        this.nodesById.set(nodeId, session);
        this.nodesByConn.set(client.connId, nodeId);
        return session;
    }
    unregister(connId) {
        const nodeId = this.nodesByConn.get(connId);
        if (!nodeId) {
            return null;
        }
        this.nodesByConn.delete(connId);
        this.nodesById.delete(nodeId);
        for (const [id, pending] of this.pendingInvokes.entries()) {
            if (pending.nodeId !== nodeId) {
                continue;
            }
            clearTimeout(pending.timer);
            pending.reject(new Error(`node disconnected (${pending.command})`));
            this.pendingInvokes.delete(id);
        }
        return nodeId;
    }
    listConnected() {
        return [...this.nodesById.values()];
    }
    get(nodeId) {
        return this.nodesById.get(nodeId);
    }
    async invoke(params) {
        const node = this.nodesById.get(params.nodeId);
        if (!node) {
            return {
                ok: false,
                error: { code: "NOT_CONNECTED", message: "node not connected" },
            };
        }
        const requestId = randomUUID();
        const payload = {
            id: requestId,
            nodeId: params.nodeId,
            command: params.command,
            paramsJSON: "params" in params && params.params !== undefined ? JSON.stringify(params.params) : null,
            timeoutMs: params.timeoutMs,
            idempotencyKey: params.idempotencyKey,
        };
        const ok = this.sendEventToSession(node, "node.invoke.request", payload);
        if (!ok) {
            return {
                ok: false,
                error: { code: "UNAVAILABLE", message: "failed to send invoke to node" },
            };
        }
        const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 30000;
        return await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingInvokes.delete(requestId);
                resolve({
                    ok: false,
                    error: { code: "TIMEOUT", message: "node invoke timed out" },
                });
            }, timeoutMs);
            this.pendingInvokes.set(requestId, {
                nodeId: params.nodeId,
                command: params.command,
                resolve,
                reject,
                timer,
            });
        });
    }
    handleInvokeResult(params) {
        const pending = this.pendingInvokes.get(params.id);
        if (!pending) {
            return false;
        }
        if (pending.nodeId !== params.nodeId) {
            return false;
        }
        clearTimeout(pending.timer);
        this.pendingInvokes.delete(params.id);
        pending.resolve({
            ok: params.ok,
            payload: params.payload,
            payloadJSON: params.payloadJSON ?? null,
            error: params.error ?? null,
        });
        return true;
    }
    sendEvent(nodeId, event, payload) {
        const node = this.nodesById.get(nodeId);
        if (!node) {
            return false;
        }
        return this.sendEventToSession(node, event, payload);
    }
    sendEventInternal(node, event, payload) {
        try {
            node.client.socket.send(JSON.stringify({
                type: "event",
                event,
                payload,
            }));
            return true;
        }
        catch {
            return false;
        }
    }
    sendEventToSession(node, event, payload) {
        return this.sendEventInternal(node, event, payload);
    }
}
