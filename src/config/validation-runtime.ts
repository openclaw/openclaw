// Callers supply declared schema property owners, excluding record keys and indices.
// Authority and isolation containers require their owners to migrate unknown restrictions.
export function isRuntimeConfigUnknownPath(path: readonly (string | number)[]): boolean {
  return !path.some(
    (segment) =>
      typeof segment === "string" &&
      [
        "auth",
        "secrets",
        "security",
        "accessGroups",
        "approvals",
        "sandbox",
        "modelPolicy",
        "permissions",
        "roles",
      ].includes(segment),
  );
}

/** Field families whose existing runtime owners define safe omission and inheritance. */
function isRuntimeOptionalValuePath(path: readonly (string | number)[]): boolean {
  const [root, section] = path;
  if (root === "ui") {
    return (
      (path.length === 2 && section === "seamColor") ||
      (path.length === 3 &&
        section === "prefs" &&
        ["theme", "themeMode", "accent"].includes(String(path[2])))
    );
  }
  if (root === "gateway") {
    return path.length === 3 && section === "controlUi" && path[2] === "communityInvite";
  }
  if (root === "logging") {
    return path.length === 2 && ["level", "consoleLevel", "consoleStyle"].includes(String(section));
  }
  if (root === "messages") {
    return (
      path.length === 2 &&
      ["responsePrefix", "ackReaction", "ackReactionScope"].includes(String(section))
    );
  }
  if (root === "tts") {
    return path.length === 2 && ["maxTextLength", "timeoutMs"].includes(String(section));
  }
  if (root === "browser") {
    return path.length === 3 && section === "snapshotDefaults" && path[2] === "mode";
  }
  if (root === "tools" && section === "media") {
    return (
      (path.length === 3 && path[2] === "concurrency") ||
      (path.length === 4 &&
        ["image", "audio", "video"].includes(String(path[2])) &&
        ["maxChars", "timeoutSeconds"].includes(String(path[3]))) ||
      (path.length === 5 &&
        path[2] === "models" &&
        typeof path[3] === "number" &&
        ["maxChars", "timeoutSeconds"].includes(String(path[4])))
    );
  }
  if (root === "agents") {
    const fields =
      section === "defaults" ? path.slice(2) : section === "entries" ? path.slice(3) : [];
    return (
      (section === "defaults" &&
        fields.length === 1 &&
        ["timeoutSeconds", "maxConcurrent"].includes(String(fields[0]))) ||
      (section === "defaults" &&
        fields.length === 2 &&
        fields[0] === "subagents" &&
        fields[1] === "maxConcurrent") ||
      (section === "entries" &&
        fields.length === 2 &&
        fields[0] === "tts" &&
        ["maxTextLength", "timeoutMs"].includes(String(fields[1]))) ||
      (fields.length === 1 && fields[0] === "typingMode") ||
      (fields.length === 2 &&
        fields[0] === "humanDelay" &&
        ["mode", "minMs", "maxMs"].includes(String(fields[1])))
    );
  }
  if (root === "models" && section === "providers") {
    return (
      (path.length === 4 && path[3] === "api") ||
      (path.length === 6 &&
        path[3] === "models" &&
        typeof path[4] === "number" &&
        ["api", "baseUrl", "contextTokens"].includes(String(path[5])))
    );
  }
  if (root === "diagnostics") {
    return path.length === 3 && section === "otel" && path[2] === "enabled";
  }
  if (root !== "channels") {
    return false;
  }
  let fields = path.slice(2);
  if (fields[0] === "accounts") {
    fields = fields.slice(2);
  }
  const speechFields = fields[0] === "voice" ? fields.slice(1) : fields;
  if (speechFields.length === 2 && speechFields[0] === "tts") {
    return ["maxTextLength", "timeoutMs"].includes(String(speechFields[1]));
  }
  // Group scopes recover interaction settings, never sender/tool policy.
  if (["guilds", "groups", "channels", "topics"].includes(String(fields[0]))) {
    while (
      ["guilds", "groups", "channels", "topics"].includes(String(fields[0])) &&
      fields.length > 2
    ) {
      fields = fields.slice(2);
    }
    return fields.length === 1 && ["requireMention", "replyToMode"].includes(String(fields[0]));
  }
  if (fields.length === 1) {
    return [
      "requireMention",
      "responsePrefix",
      "ackReaction",
      "textChunkLimit",
      "replyToMode",
    ].includes(String(fields[0]));
  }
  if (fields[0] === "markdown") {
    return fields.length === 2 && fields[1] === "tables";
  }
  if (fields[0] === "replyToModeByChatType") {
    return fields.length === 2 && ["direct", "group", "channel"].includes(String(fields[1]));
  }
  if (fields[0] !== "streaming") {
    return false;
  }
  const [, scope, field, leaf] = fields;
  if (fields.length === 2) {
    return scope === "mode" || scope === "chunkMode";
  }
  if (fields.length === 3) {
    return (
      (scope === "block" && field === "enabled") ||
      (scope === "preview" && ["toolProgress", "commandText"].includes(String(field))) ||
      (scope === "progress" &&
        [
          "label",
          "maxLines",
          "maxLineChars",
          "toolProgress",
          "commandText",
          "commentary",
          "narration",
        ].includes(String(field)))
    );
  }
  return (
    fields.length === 4 &&
    ((scope === "preview" &&
      field === "chunk" &&
      ["minChars", "maxChars", "breakPreference"].includes(String(leaf))) ||
      (scope === "block" &&
        field === "coalesce" &&
        ["minChars", "maxChars", "idleMs"].includes(String(leaf))))
  );
}

/** The optional environment badge is one label/color value, not a partial runtime contract. */
export function resolveRuntimeOptionalValuePath(
  path: readonly (string | number)[],
): (string | number)[] | undefined {
  if (
    path[0] === "gateway" &&
    path[1] === "controlUi" &&
    path[2] === "environment" &&
    (path.length === 3 || (path.length === 4 && ["label", "color"].includes(String(path[3]))))
  ) {
    return path.slice(0, 3);
  }
  return isRuntimeOptionalValuePath(path) ? [...path] : undefined;
}

/** Omit schema-rejected paths only from an isolated runtime candidate. */
export function omitRuntimeConfigPaths(
  value: unknown,
  paths: ReadonlyArray<ReadonlyArray<string | number>>,
): unknown {
  const candidate: unknown = structuredClone(value);
  for (const path of paths) {
    let parent = candidate;
    for (const segment of path.slice(0, -1)) {
      if (parent === null || typeof parent !== "object" || !Object.hasOwn(parent, segment)) {
        parent = undefined;
        break;
      }
      parent = Reflect.get(parent, segment);
    }
    const key = path.at(-1);
    if (key !== undefined && parent !== null && typeof parent === "object") {
      Reflect.deleteProperty(parent, key);
    }
  }
  return candidate;
}
