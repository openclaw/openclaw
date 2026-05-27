type MatrixConversationParams = {
  ctx: {
    MessageThreadId?: string | number | null;
    OriginatingTo?: string;
    To?: string;
  };
  command: {
    to?: string;
  };
};

function normalizeMatrixTarget(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveMatrixRoomIdFromTarget(raw: string): string | undefined {
  let target = normalizeMatrixTarget(raw);
  if (!target) {
    return undefined;
  }
  if (target.toLowerCase().startsWith("matrix:")) {
    target = target.slice("matrix:".length).trim();
  }
  if (/^(room|channel):/i.test(target)) {
    const roomId = target.replace(/^(room|channel):/i, "").trim();
    return roomId || undefined;
  }
  if (target.startsWith("!") || target.startsWith("#")) {
    return target;
  }
  return undefined;
}

export function resolveMatrixParentConversationId(
  params: MatrixConversationParams,
): string | undefined {
  const targets = [params.ctx.OriginatingTo, params.command.to, params.ctx.To];
  for (const candidate of targets) {
    const roomId = resolveMatrixRoomIdFromTarget(candidate ?? "");
    if (roomId) {
      return roomId;
    }
  }
  return undefined;
}

export function resolveMatrixConversationId(params: MatrixConversationParams): string | undefined {
  const threadId =
    params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
  if (threadId) {
    return threadId;
  }
  return resolveMatrixParentConversationId(params);
}
