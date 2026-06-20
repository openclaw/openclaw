// Private helper surface for bundled node-aware plugins (e.g. the browser
// extension bridge) to originate node-attributed gateway events over this
// node's authenticated connection. Kept out of the public plugin SDK so a
// third-party plugin cannot install an emitter or forge node-attributed events
// over the node connection.

export { emitNodeGatewayEvent } from "../node-host/node-event-emitter.js";
