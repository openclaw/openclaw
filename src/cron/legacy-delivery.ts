export function hasLegacyDeliveryHints(payload: Record<string, unknown>) {
  if (typeof payload.deliver === "boolean") {
    return true;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    return true;
  }
  if (typeof payload.channel === "string" && payload.channel.trim()) {
    return true;
  }
  if (typeof payload.provider === "string" && payload.provider.trim()) {
    return true;
  }
  if (typeof payload.to === "string" && payload.to.trim()) {
    return true;
  }
  if (typeof payload.threadId === "string" && payload.threadId.trim()) {
    return true;
  }
  if (typeof payload.threadId === "number" && Number.isFinite(payload.threadId)) {
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
    typeof payload.channel === "string" && payload.channel.trim()
      ? payload.channel.trim().toLowerCase()
      : typeof payload.provider === "string"
        ? payload.provider.trim().toLowerCase()
        : "";
  const toRaw = typeof payload.to === "string" ? payload.to.trim() : "";
  const threadIdRaw =
    typeof payload.threadId === "string"
      ? payload.threadId.trim()
      : typeof payload.threadId === "number" && Number.isFinite(payload.threadId)
        ? String(payload.threadId)
        : "";
  const next: Record<string, unknown> = { mode };
  if (channelRaw) {
    next.channel = channelRaw;
  }
  if (toRaw) {
    next.to = toRaw;
  }
  if (threadIdRaw) {
    next.threadId = threadIdRaw;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    next.bestEffort = payload.bestEffortDeliver;
  }
  return next;
}

export function buildDeliveryPatchFromLegacyPayload(payload: Record<string, unknown>) {
  const deliver = payload.deliver;
  const channelRaw =
    typeof payload.channel === "string" && payload.channel.trim()
      ? payload.channel.trim().toLowerCase()
      : typeof payload.provider === "string" && payload.provider.trim()
        ? payload.provider.trim().toLowerCase()
        : "";
  const toRaw = typeof payload.to === "string" ? payload.to.trim() : "";
  const threadIdRaw =
    typeof payload.threadId === "string"
      ? payload.threadId.trim()
      : typeof payload.threadId === "number" && Number.isFinite(payload.threadId)
        ? String(payload.threadId)
        : "";
  const next: Record<string, unknown> = {};
  let hasPatch = false;

  if (deliver === false) {
    next.mode = "none";
    hasPatch = true;
  } else if (
    deliver === true ||
    channelRaw ||
    toRaw ||
    threadIdRaw ||
    typeof payload.bestEffortDeliver === "boolean"
  ) {
    next.mode = "announce";
    hasPatch = true;
  }
  if (channelRaw) {
    next.channel = channelRaw;
    hasPatch = true;
  }
  if (toRaw) {
    next.to = toRaw;
    hasPatch = true;
  }
  if (threadIdRaw) {
    next.threadId = threadIdRaw;
    hasPatch = true;
  }
  if (typeof payload.bestEffortDeliver === "boolean") {
    next.bestEffort = payload.bestEffortDeliver;
    hasPatch = true;
  }

  return hasPatch ? next : null;
}

export function mergeLegacyDeliveryInto(
  delivery: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  const patch = buildDeliveryPatchFromLegacyPayload(payload);
  if (!patch) {
    return { delivery, mutated: false };
  }

  const next = { ...delivery };
  let mutated = false;

  if ("mode" in patch && patch.mode !== next.mode) {
    next.mode = patch.mode;
    mutated = true;
  }
  if ("channel" in patch && patch.channel !== next.channel) {
    next.channel = patch.channel;
    mutated = true;
  }
  if ("to" in patch && patch.to !== next.to) {
    next.to = patch.to;
    mutated = true;
  }
  if ("threadId" in patch && patch.threadId !== next.threadId) {
    next.threadId = patch.threadId;
    mutated = true;
  }
  if ("bestEffort" in patch && patch.bestEffort !== next.bestEffort) {
    next.bestEffort = patch.bestEffort;
    mutated = true;
  }

  return { delivery: next, mutated };
}

export function normalizeLegacyDeliveryInput(params: {
  delivery?: Record<string, unknown> | null;
  payload?: Record<string, unknown> | null;
}) {
  if (!params.payload || !hasLegacyDeliveryHints(params.payload)) {
    return {
      delivery: params.delivery ?? undefined,
      mutated: false,
    };
  }

  const nextDelivery = params.delivery
    ? mergeLegacyDeliveryInto(params.delivery, params.payload)
    : {
        delivery: buildDeliveryFromLegacyPayload(params.payload),
        mutated: true,
      };
  stripLegacyDeliveryFields(params.payload);
  return {
    delivery: nextDelivery.delivery,
    mutated: true,
  };
}

export function stripLegacyDeliveryFields(payload: Record<string, unknown>) {
  if ("deliver" in payload) {
    delete payload.deliver;
  }
  if ("channel" in payload) {
    delete payload.channel;
  }
  if ("provider" in payload) {
    delete payload.provider;
  }
  if ("to" in payload) {
    delete payload.to;
  }
  if ("threadId" in payload) {
    delete payload.threadId;
  }
  if ("bestEffortDeliver" in payload) {
    delete payload.bestEffortDeliver;
  }
}
