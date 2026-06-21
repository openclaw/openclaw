// Private helper surface for the bundled browser plugin's node-anchored bridge.
// Keep the node->gateway event emitter OUT of the public plugin SDK surface: the
// bridge originates node-attributed turns, a privileged capability that must not
// be exposed to arbitrary plugins via the onNodeHostStart ctx (review high-sev).
export { emitNodeGatewayEvent } from "../node-host/node-event-emitter.js";
