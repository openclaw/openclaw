/**
 * Curated table of known OpenClaw gateway log patterns.
 *
 * This is injected into the system prompt so the AI model can reference
 * authoritative explanations and fixes rather than guessing. Patterns are
 * maintained from real-world operational experience.
 */

export const KNOWN_ISSUES_PROMPT = `\
## Known Gateway Issue Patterns

When you encounter any of these patterns in the diagnostic data, use the
explanation and fix provided here rather than speculating.

- \`[auth] rejected request: invalid token\` — the gateway received a request
  with the wrong auth token. Check that \`gateway.auth.token\` in
  \`openclaw.json\` matches the token used by the client. If the token
  references an environment variable (\`\${OPENCLAW_GATEWAY_TOKEN}\`), verify
  the variable is set in \`~/.openclaw/.env\`.

- \`[ws] client disconnected unexpectedly\` — the browser client lost the
  WebSocket connection. Usually transient. Persistent occurrences indicate
  network instability, a reverse-proxy timeout, or the gateway process
  crashing and restarting.

- \`[agent] context limit approaching\` — the agent's conversation is near the
  model's context window limit. The user should start a new session or the
  gateway will compact the context (which may lose earlier instructions).

- \`[startup] workspace not found\` — the \`agents.list[main].workspace\` path
  in \`openclaw.json\` does not exist on disk. Create the directory or correct
  the path.

- \`[health] check failed: ECONNREFUSED\` — the watchdog ping to the gateway
  health endpoint was refused. The gateway process may have crashed. Check
  \`openclaw gateway status\` and restart if needed.

- \`Invalid config at ... Unrecognized key:\` — a top-level key in
  \`openclaw.json\` is not recognized by the installed OpenClaw version. This
  usually happens after an upgrade that moves or removes config keys. Back up
  the file and run \`openclaw doctor --fix\`, or manually remove the
  unrecognized key.

- \`ERR_MODULE_NOT_FOUND ... commands.runtime-*.js\` — the gateway is trying to
  load a dynamic import chunk from a previous version's build. This happens
  when the npm package was updated but the gateway process was not restarted.
  Fix: \`openclaw gateway restart\`.

- \`tools.web.search: ... provider-owned config moved to plugins\` — a legacy
  \`tools.web.search\` configuration is present that was moved to the plugin
  system. Run \`openclaw doctor --fix\` to migrate automatically.

- \`channels.telegram.streamMode\` / \`streaming (scalar)\` / \`chunkMode\` /
  \`blockStreaming\` — legacy scalar streaming configuration. The current
  schema uses \`channels.telegram.streaming.{mode,chunkMode,...}\`. Run
  \`openclaw doctor --fix\` to migrate.

- \`[agent/embedded] incomplete turn detected: ... payloads=0\` — the model
  returned a stop signal but produced no content. This is a model-level or
  provider-level issue (not an OpenClaw bug). Try a different model or check
  the provider's status page.
`;
