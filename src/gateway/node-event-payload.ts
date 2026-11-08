const SERIALIZED_EVENT_PAYLOAD = Symbol("openclaw.serializedEventPayload");

export type SerializedEventPayload = {
  readonly json: string;
  readonly [SERIALIZED_EVENT_PAYLOAD]: true;
};

/** Serialize an event payload once so fanout can reuse the same JSON string. */
export function serializeEventPayload(payload: unknown): SerializedEventPayload | null {
  if (payload === undefined) {
    return null;
  }
  const json = JSON.stringify(payload);
  return typeof json === "string" ? { json, [SERIALIZED_EVENT_PAYLOAD]: true } : null;
}

/** Narrow values created by serializeEventPayload. */
export function isSerializedEventPayload(value: unknown): value is SerializedEventPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    Reflect.get(value, SERIALIZED_EVENT_PAYLOAD) === true &&
    typeof Reflect.get(value, "json") === "string"
  );
}
