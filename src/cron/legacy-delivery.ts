export function hasLegacyDeliveryHints(payload: Record<string, unknown>) {
  if (typeof payload.deliver === "boolean") {
    return true;
  }
  if (typeof payload.channel === "string" && payload.channel.trim()) {
    return true;
  }
  if (typeof payload.provider === "string" && payload.provider.trim()) {
    return true;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    return true;
  }
  if (typeof payload.to === "string" && payload.to.trim()) {
    return true;
  }
  return false;
}

export function buildDeliveryFromLegacyPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const deliver = payload.deliver;
  const mode = deliver === false ? "none" : "announce";
  const channelRaw =
    typeof payload.channel === "string" ? payload.channel.trim().toLowerCase() : "";
  const providerRaw =
    typeof payload.provider === "string" ? payload.provider.trim().toLowerCase() : "";
  const resolvedChannel = channelRaw || providerRaw;
  const toRaw = typeof payload.to === "string" ? payload.to.trim() : "";
  const next: Record<string, unknown> = { mode };
  if (resolvedChannel) {
    next.channel = resolvedChannel;
  }
  if (toRaw) {
    next.to = toRaw;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    next.bestEffort = payload.bestEffortDeliver;
  }
  return next;
}

export function stripLegacyDeliveryFields(payload: Record<string, unknown>) {
  if ("deliver" in payload) {
    delete payload.deliver;
  }
  if ("provider" in payload) {
    delete payload.provider;
  }
  if ("channel" in payload) {
    delete payload.channel;
  }
  if ("to" in payload) {
    delete payload.to;
  }
  if ("bestEffortDeliver" in payload) {
    delete payload.bestEffortDeliver;
  }
}
