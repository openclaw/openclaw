type GatewayAdmissionEvent = {
  type: "gateway.admission";
  method: "gateway.restart.request";
};

const coreGatewayAdmissionEvents = new WeakSet<object>();
const coreGatewayOwnerEvents = new WeakSet<object>();

export function markCoreGatewayOwnerEvent<T extends { type: "gateway.run.owner" }>(event: T): T {
  coreGatewayOwnerEvents.add(event);
  return event;
}

export function consumeCoreGatewayOwnerEvent(event: object): boolean {
  const marked = coreGatewayOwnerEvents.has(event);
  coreGatewayOwnerEvents.delete(event);
  return marked;
}

/** Only the native producer can mark an exact event; payload fields cannot claim provenance. */
export function markCoreGatewayAdmissionEvent<T extends GatewayAdmissionEvent>(event: T): T {
  coreGatewayAdmissionEvents.add(event);
  return event;
}

export function consumeCoreGatewayAdmissionEvent(event: object): boolean {
  const marked = coreGatewayAdmissionEvents.has(event);
  coreGatewayAdmissionEvents.delete(event);
  return marked;
}
