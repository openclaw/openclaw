import type { SystemAgentOperation } from "./operation-types.js";

type RunReadOperation = Extract<
  SystemAgentOperation,
  {
    kind:
      | "status"
      | "health"
      | "config-get"
      | "config-validate"
      | "config-schema"
      | "logs"
      | "gateway-status"
      | "gateway-status-deep"
      | "plugin-list"
      | "plugins-doctor"
      | "skills-check"
      | "models-status"
      | "channels-status";
  }
>;

// Exact argv aliases for existing Ask OpenClaw reads. There is no CLI fallback.
const READS: ReadonlyArray<{ argv: readonly string[]; operation: RunReadOperation }> = [
  { argv: ["status"], operation: { kind: "status" } },
  { argv: ["health"], operation: { kind: "health" } },
  { argv: ["config", "validate"], operation: { kind: "config-validate" } },
  { argv: ["config", "schema"], operation: { kind: "config-schema" } },
  { argv: ["logs"], operation: { kind: "logs" } },
  { argv: ["gateway", "status"], operation: { kind: "gateway-status" } },
  { argv: ["gateway", "status", "--deep"], operation: { kind: "gateway-status-deep" } },
  { argv: ["daemon", "status"], operation: { kind: "gateway-status" } },
  { argv: ["daemon", "status", "--deep"], operation: { kind: "gateway-status-deep" } },
  { argv: ["plugins", "list"], operation: { kind: "plugin-list" } },
  { argv: ["plugins", "doctor"], operation: { kind: "plugins-doctor" } },
  { argv: ["skills", "check"], operation: { kind: "skills-check" } },
  { argv: ["models", "status"], operation: { kind: "models-status" } },
  { argv: ["channels", "status"], operation: { kind: "channels-status" } },
  { argv: ["channels", "status", "--probe"], operation: { kind: "channels-status", probe: true } },
];

export function resolveSystemAgentRunRead(argv: readonly string[]): RunReadOperation | undefined {
  if (argv.length === 3 && argv[0] === "config" && argv[1] === "get") {
    const path = argv[2]?.trim();
    return path && !path.startsWith("-") && !/[\p{Cc}\p{Bidi_Control}]/u.test(path)
      ? { kind: "config-get", path }
      : undefined;
  }
  return READS.find(
    ({ argv: expected }) =>
      expected.length === argv.length && expected.every((arg, index) => arg === argv[index]),
  )?.operation;
}
