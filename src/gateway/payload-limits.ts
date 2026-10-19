// Keep server maxPayload aligned with gateway client maxPayload so high-res canvas snapshots
// don't get disconnected mid-invoke with "Max payload size exceeded". Session and worker owners
// share this limit, so it lives outside the Gateway server graph.
export const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
