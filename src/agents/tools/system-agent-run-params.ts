import { Type } from "typebox";
import { ToolInputError } from "./common.js";

const MAX_RUN_ARGV_TOKENS = 48;
const MAX_RUN_ARGV_TOKEN_CHARS = 2048;

export const SystemAgentRunArgvSchema = Type.Optional(
  Type.Array(Type.String({ minLength: 1, maxLength: MAX_RUN_ARGV_TOKEN_CHARS }), {
    minItems: 1,
    maxItems: MAX_RUN_ARGV_TOKENS,
    description:
      'For run: the arguments after `openclaw`, one token per item, for example ["config","get","gateway.port"].',
  }),
);

export function readSystemAgentRunArgv(params: Record<string, unknown>): string[] {
  const { argv } = params;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.length > MAX_RUN_ARGV_TOKENS ||
    !argv.every(
      (token) =>
        typeof token === "string" &&
        token.length > 0 &&
        token.length <= MAX_RUN_ARGV_TOKEN_CHARS &&
        !token.includes("\0"),
    )
  ) {
    throw new ToolInputError(
      'openclaw: run requires argv, the arguments after `openclaw` as a non-empty list of strings, for example ["status"]',
    );
  }
  return [...argv];
}
