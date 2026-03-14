import {
  formatSlackStreamingBooleanMigrationMessage,
  formatSlackStreamModeMigrationMessage,
  resolveDiscordPreviewStreamMode,
  resolveSlackNativeStreaming,
  resolveSlackStreamingMode,
  resolveTelegramPreviewStreamMode,
} from "../config/discord-preview-streaming.js";

function normalizePreviewStreamingAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  resolveStreaming: (entry: Record<string, unknown>) => string;
}): { entry: Record<string, unknown>; changed: boolean; changes: string[] } {
  const changes: string[] = [];
  let updated = params.entry;
  const hadLegacyStreamMode = updated.streamMode !== undefined;
  const beforeStreaming = updated.streaming;
  const resolved = params.resolveStreaming(updated);
  const shouldNormalize =
    hadLegacyStreamMode ||
    typeof beforeStreaming === "boolean" ||
    (typeof beforeStreaming === "string" && beforeStreaming !== resolved);
  if (!shouldNormalize) {
    return { entry: updated, changed: false, changes };
  }

  let changed = false;
  if (beforeStreaming !== resolved) {
    updated = { ...updated, streaming: resolved };
    changed = true;
  }
  if (hadLegacyStreamMode) {
    const { streamMode: _ignored, ...rest } = updated;
    updated = rest;
    changed = true;
    changes.push(
      `Moved ${params.pathPrefix}.streamMode → ${params.pathPrefix}.streaming (${resolved}).`,
    );
  }
  if (typeof beforeStreaming === "boolean") {
    changes.push(`Normalized ${params.pathPrefix}.streaming boolean → enum (${resolved}).`);
  } else if (typeof beforeStreaming === "string" && beforeStreaming !== resolved) {
    changes.push(`Normalized ${params.pathPrefix}.streaming (${beforeStreaming}) → (${resolved}).`);
  }

  return { entry: updated, changed, changes };
}

function normalizeSlackStreamingAliases(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
}): { entry: Record<string, unknown>; changed: boolean; changes: string[] } {
  const changes: string[] = [];
  let updated = params.entry;
  const hadLegacyStreamMode = updated.streamMode !== undefined;
  const legacyStreaming = updated.streaming;
  const beforeStreaming = updated.streaming;
  const beforeNativeStreaming = updated.nativeStreaming;
  const resolvedStreaming = resolveSlackStreamingMode(updated);
  const resolvedNativeStreaming = resolveSlackNativeStreaming(updated);
  const shouldNormalize =
    hadLegacyStreamMode ||
    typeof legacyStreaming === "boolean" ||
    (typeof legacyStreaming === "string" && legacyStreaming !== resolvedStreaming);
  if (!shouldNormalize) {
    return { entry: updated, changed: false, changes };
  }

  let changed = false;
  if (beforeStreaming !== resolvedStreaming) {
    updated = { ...updated, streaming: resolvedStreaming };
    changed = true;
  }
  if (
    typeof beforeNativeStreaming !== "boolean" ||
    beforeNativeStreaming !== resolvedNativeStreaming
  ) {
    updated = { ...updated, nativeStreaming: resolvedNativeStreaming };
    changed = true;
  }
  if (hadLegacyStreamMode) {
    const { streamMode: _ignored, ...rest } = updated;
    updated = rest;
    changed = true;
    changes.push(formatSlackStreamModeMigrationMessage(params.pathPrefix, resolvedStreaming));
  }
  if (typeof legacyStreaming === "boolean") {
    changes.push(
      formatSlackStreamingBooleanMigrationMessage(params.pathPrefix, resolvedNativeStreaming),
    );
  } else if (typeof legacyStreaming === "string" && legacyStreaming !== resolvedStreaming) {
    changes.push(
      `Normalized ${params.pathPrefix}.streaming (${legacyStreaming}) → (${resolvedStreaming}).`,
    );
  }

  return { entry: updated, changed, changes };
}

export function normalizeStreamingAliasesForProvider(params: {
  provider: "telegram" | "slack" | "discord";
  entry: Record<string, unknown>;
  pathPrefix: string;
}): { entry: Record<string, unknown>; changed: boolean; changes: string[] } {
  if (params.provider === "telegram") {
    return normalizePreviewStreamingAliases({
      entry: params.entry,
      pathPrefix: params.pathPrefix,
      resolveStreaming: resolveTelegramPreviewStreamMode,
    });
  }
  if (params.provider === "discord") {
    return normalizePreviewStreamingAliases({
      entry: params.entry,
      pathPrefix: params.pathPrefix,
      resolveStreaming: resolveDiscordPreviewStreamMode,
    });
  }
  return normalizeSlackStreamingAliases({
    entry: params.entry,
    pathPrefix: params.pathPrefix,
  });
}
