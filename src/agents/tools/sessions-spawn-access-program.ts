import type { CyberAccessProgram } from "../../../packages/gateway-protocol/src/schema/sessions-row.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { ToolInputError } from "./common.js";

const CYBER_ACCESS_PROGRAMS = [
  "standard",
  "daybreak_blue",
  "daybreak_red",
] as const satisfies readonly CyberAccessProgram[];

export const SESSIONS_SPAWN_CYBER_ACCESS_PROGRAM_SCHEMA = optionalStringEnum(
  CYBER_ACCESS_PROGRAMS,
  {
    description:
      "Child OpenAI cyber Access (Blue=daybreak_blue, Red=daybreak_red). Omit: same-agent, same-model child keeps requester Access. Child run fails if its account/model lacks the program. Subagent only.",
  },
);

/** Strict tool schemas send null for omitted optionals; null keeps inheritance. */
export function readSessionsSpawnCyberAccessProgram(
  params: Record<PropertyKey, unknown>,
  runtime: "subagent" | "acp",
): CyberAccessProgram | undefined {
  const value = params.cyberAccessProgram;
  if (value === undefined || value === null) {
    return undefined;
  }
  const program = CYBER_ACCESS_PROGRAMS.find((candidate) => candidate === value);
  if (!program) {
    throw new ToolInputError(
      `sessions_spawn cyberAccessProgram must be one of: ${CYBER_ACCESS_PROGRAMS.join(", ")}.`,
    );
  }
  if (runtime === "acp") {
    throw new ToolInputError(
      'sessions_spawn cyberAccessProgram requires runtime="subagent"; ACP harnesses do not apply OpenAI Access. Omit cyberAccessProgram or use runtime="subagent".',
    );
  }
  return program;
}
