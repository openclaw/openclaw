import { getDiscordGatewayEmitter } from "../monitor.gateway.js";
export function attachEarlyGatewayErrorGuard(client) {
    const pendingErrors = [];
    const gateway = client.getPlugin("gateway");
    const emitter = getDiscordGatewayEmitter(gateway);
    if (!emitter) {
        return {
            pendingErrors,
            release: () => { },
        };
    }
    let released = false;
    const onGatewayError = (err) => {
        pendingErrors.push(err);
    };
    emitter.on("error", onGatewayError);
    return {
        pendingErrors,
        release: () => {
            if (released) {
                return;
            }
            released = true;
            emitter.removeListener("error", onGatewayError);
        },
    };
}
