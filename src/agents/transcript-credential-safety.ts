export const SECRET_EGRESS_USAGE_PROMPT =
  "Gateway-host commands: use auto-injected opaque env sentinel under stored name. No secret templates; never override/print that variable. Native shell/sandbox/node: no protected injection. First command snapshots store for run; late saves need next turn.";

/** Protected secrets-tool usage only; no general credential-entry policy. */
export function buildCredentialSafetyPrompt(secretsToolName?: string): string {
  if (!secretsToolName) {
    return "";
  }
  return [
    `\`${secretsToolName}\`: list metadata first; request only missing task-needed credentials: name + reason, exact allowedHosts for egress.`,
    "Human masked entry -> protected shared store; metadata/ref only. Use returned store SecretRef on supported config fields.",
    "Gateway egress needs enabled proxy + allowed hosts; no plaintext fallback.",
    SECRET_EGRESS_USAGE_PROMPT,
    "no_answer: continue independent work; if the credential blocks progress, explain the missing setup.",
  ].join("\n");
}
