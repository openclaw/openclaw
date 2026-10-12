/** Build node.event params, shared by the invoke dispatcher and the runtime. */
export function buildNodeEventParams(event: string, payload: unknown) {
  const payloadJSON = payload === undefined ? undefined : JSON.stringify(payload);
  return {
    event,
    payloadJSON: payloadJSON ?? null,
  };
}
