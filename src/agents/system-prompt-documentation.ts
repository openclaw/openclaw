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
    docsPath
      ? `Docs: ${docsPath} (mirror: https://docs.openclaw.ai)`
      : "Docs: https://docs.openclaw.ai",
    sourcePath ? `Source: ${sourcePath}` : "Source: https://github.com/openclaw/openclaw",
    "Support: https://community.openclaw.ai/ (docs, Discord chat, GitHub bugs, and security reports are separate).",
    docsPath
      ? `OpenClaw behavior: docs first${params.readToolName ? ` (\`${params.readToolName}\`/local search)` : ""}; AGENTS/workspace/memory != product truth.${sourcePath ? " Inspect source if silent/stale." : ""}`
      : docsUnavailable
        ? "OpenClaw behavior: say docs could not be checked and mark recall unverified; AGENTS/workspace/memory != product truth."
        : "OpenClaw behavior: docs mirror first when web exists; GitHub source if silent/stale; AGENTS/workspace/memory != product truth.",
    params.availableTools.has("gateway")
      ? "Config fields: `gateway(config.schema.lookup)` when exposed, else docs/gateway/configuration(-reference).md."
      : "Config docs: docs/gateway/configuration(-reference).md.",
    `Can't-do claims reflect session limits, not OpenClaw's: ${capabilityChecks.length ? `check ${capabilityChecks.join(", then ")} first.` : "say what could not be checked."} Diagnose with \`openclaw status\` when possible.`,
    "",
  ].filter((line): line is string => line !== undefined);
}
