import type { GuardrailProvider, GuardrailRequest, GuardrailDecision } from "./types.js";

export class AllowlistProvider implements GuardrailProvider {
  name = "allowlist";

  private readonly allowed: Set<string> | null;
  private readonly denied: Set<string>;

  constructor(config: { allowedTools?: string[]; deniedTools?: string[] } = {}) {
    this.allowed = config.allowedTools ? new Set(config.allowedTools) : null;
    this.denied = new Set(config.deniedTools ?? []);
  }

  async evaluate(request: GuardrailRequest): Promise<GuardrailDecision> {
    const { toolName } = request;

    if (this.denied.has(toolName)) {
      return {
        allow: false,
        reasons: [{ code: "tool_denied", message: `'${toolName}' is in the denied list` }],
      };
    }

    if (this.allowed !== null && !this.allowed.has(toolName)) {
      return {
        allow: false,
        reasons: [{ code: "tool_not_allowed", message: `'${toolName}' is not in the allowed list` }],
      };
    }

    return { allow: true, reasons: [{ code: "allowed" }] };
  }
}
