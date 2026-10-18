export function buildDocumentationSection(params: {
  docsPath?: string;
  sourcePath?: string;
  readToolName?: string;
  availableTools: ReadonlySet<string>;
  sandboxed: boolean;
}): string[] {
  const docsPath = params.docsPath?.trim();
  const sourcePath = params.sourcePath?.trim();
  const webRetrieval = ["web_fetch", "web_search", "browser"].some((name) =>
    params.availableTools.has(name),
  );
  const docsUnavailable = params.sandboxed && !docsPath && !webRetrieval;
  // Name only checks this session can run: the remote index needs a web tool.
  const capabilityChecks = [
    params.availableTools.has("session_status")
      ? "`session_status` with `capabilities=true`"
      : undefined,
    webRetrieval
      ? "the docs index https://docs.openclaw.ai/llms.txt"
      : docsPath
        ? "the local docs"
        : undefined,
  ].filter((check): check is string => check !== undefined);
  return [
    "## Documentation",
    docsPath ? `Docs: ${docsPath}` : "Docs: https://docs.openclaw.ai",
    docsPath ? "Mirror: https://docs.openclaw.ai" : undefined,
    sourcePath ? `Source: ${sourcePath}` : "Source: https://github.com/openclaw/openclaw",
    docsPath
      ? `OpenClaw behavior questions: docs first${params.readToolName ? ` via \`${params.readToolName}\`/local search` : " using available tools"}. AGENTS/project/workspace/profile/memory = instructions/user memory, not product design truth.`
      : docsUnavailable
        ? "OpenClaw behavior questions: say docs could not be checked; mark recalled behavior as unverified. AGENTS/project/workspace/profile/memory = instructions/user memory, not product design truth."
        : "OpenClaw behavior questions: docs mirror first when web exists. AGENTS/project/workspace/profile/memory = instructions/user memory, not product design truth.",
    params.availableTools.has("gateway")
      ? "Config field: use `gateway(config.schema.lookup)` with an exact path only when that action is exposed by the tool schema. Otherwise use `docs/gateway/configuration.md` and `docs/gateway/configuration-reference.md`."
      : "Configuration docs: `docs/gateway/configuration.md`, `docs/gateway/configuration-reference.md`.",
    sourcePath
      ? "If docs are silent/stale, say so and inspect local source."
      : docsUnavailable
        ? undefined
        : "If docs are silent/stale, say so and inspect GitHub source.",
    `Can't-do claims: a missing tool or failed call shows this session's limits, not OpenClaw's; ${capabilityChecks.length ? `check ${capabilityChecks.join(", then ")} before saying OpenClaw can't.` : "say what you could not check."}`,
    "Diagnosis: run `openclaw status` when possible; ask only if blocked.",
    "",
  ].filter((line): line is string => line !== undefined);
}
