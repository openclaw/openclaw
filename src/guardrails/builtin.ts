import type { GuardrailProvider, GuardrailRequest, GuardrailDecision } from "./types.js";

function toStringArray(value: string[] | string | undefined): string[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [value];
}

export class AllowlistProvider implements GuardrailProvider {
  name = "allowlist";

  private readonly allowed: Set<string> | null;
  private readonly denied: Set<string>;

  constructor(config: { allowedTools?: string[] | string; deniedTools?: string[] | string } = {}) {
    this.allowed = config.allowedTools ? new Set(toStringArray(config.allowedTools)) : null;
    this.denied = new Set(toStringArray(config.deniedTools));
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
        reasons: [
          { code: "tool_not_allowed", message: `'${toolName}' is not in the allowed list` },
        ],
      };
    }

    return { allow: true, reasons: [{ code: "allowed" }] };
  }
}
