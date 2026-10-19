import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { SessionMoveProfileTargetSchema } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import { WORKTREE_NAME_PATTERN } from "../worktrees/name.js";
import { readToolStringParam, ToolInputError } from "./common.js";

export const SessionsSpawnPlacementSchema = Type.Union([
  Type.Object({ kind: Type.Literal("local") }, { additionalProperties: false }),
  SessionMoveProfileTargetSchema,
]);

export const SESSIONS_SPAWN_SESSION_SCHEMA = {
  placement: Type.Optional({
    ...SessionsSpawnPlacementSchema,
    description:
      'Execution placement: omitted or {kind: "local"} uses local execution for native and ACP runs. {kind: "profile", profileId, os?, machineClass?} selects a configured cloud profile and requires visible=true and worktree=true. Never supply placeholder selectors. Omitted cloud selectors use profile defaults; the first task starts only after cloud dispatch.',
  }),
  visible: Type.Optional(
    Type.Boolean({
      description:
        "Persistent sidebar session only when the user requests a separate session or needs to revisit and steer it independently. Internal QA/coding/review/test workers: omit or false. Subagent runtime only; default run mode and empty attachments accepted; thinking is supported with visible=true; no thread/lightContext or attachment staging.",
    }),
  ),
  group: Type.Optional(
    Type.String({
      description:
        "Custom sidebar group; requires visible=true when nonempty. A new name creates the group. Omit or pass an empty string to leave it ungrouped.",
    }),
  ),
  projectId: Type.Optional(
    Type.String({
      description:
        "Registered project for a native subagent; hidden children require worktree=true. Mutually exclusive with projectGitUrl and cwd.",
    }),
  ),
  projectGitUrl: Type.Optional(
    Type.String({
      description:
        "GitHub HTTPS or git@github.com repository URL for a visible session's managed clone; mutually exclusive with projectId and cwd. Local paths and file URLs are not accepted.",
      maxLength: 2048,
    }),
  ),
  worktree: Type.Optional(
    Type.Boolean({
      description:
        'Managed checkout for hidden or visible runtime="subagent"; first turn waits for preparation. ACP unsupported.',
    }),
  ),
  worktreeName: Type.Optional(
    Type.String({
      pattern: WORKTREE_NAME_PATTERN.source,
      description:
        "Managed worktree lowercase slug, 1–64 letters/digits/hyphens, starting with a letter or digit. Do not include a branch prefix such as codex/; OpenClaw supplies openclaw/. Requires worktree=true.",
    }),
  ),
  worktreeBaseRef: Type.Optional(
    Type.String({ description: "Managed worktree base ref; requires worktree=true." }),
  ),
};

export function validateVisibleSpawnOptions(
  raw: Record<string, unknown>,
  runtime: "subagent" | "acp",
): void {
  // A visible session starts one run; empty attachment fields request no staging.
  const requestedMode = raw.mode === "run" ? undefined : raw.mode;
  const unsupported = [
    ["runtime", runtime === "subagent" ? undefined : runtime, 'supports runtime="subagent" only'],
    [
      "thread",
      raw.thread === true ? true : undefined,
      "visible sessions route to the dashboard, not a channel thread",
    ],
    ["mode", requestedMode, "visible sessions are persistent dashboard sessions"],
    [
      "lightContext",
      raw.lightContext === true ? true : undefined,
      "bootstrap staging is not wired to the sessions.create path",
    ],
    [
      "attachments",
      Array.isArray(raw.attachments) && raw.attachments.length > 0 ? raw.attachments : undefined,
      "attachment staging is not wired to the sessions.create path",
    ],
    [
      "attachAs",
      isRecord(raw.attachAs) ? readToolStringParam(raw.attachAs, "mountPath") : raw.attachAs,
      "attachment staging is not wired to the sessions.create path",
    ],
  ] as const;
  const unsupportedEntries = unsupported.filter(([, value]) => value !== undefined);
  if (unsupportedEntries.length > 0) {
    throw new ToolInputError(
      `Parameters unavailable with visible=true: ${unsupportedEntries
        .map(([name, , reason]) => `${name}: ${reason}`)
        .join("; ")}`,
    );
  }
}

/** Formats the visible spawn call a model should retry with. */
export function correctedVisibleSpawnCall(raw: Record<string, unknown>): string {
  const corrected = Object.fromEntries(
    [
      "task",
      "user",
      "taskName",
      "label",
      "agentId",
      "model",
      "thinking",
      "runTimeoutSeconds",
      "cwd",
      "expectsCompletionMessage",
      "sandbox",
      "context",
      "placement",
      "group",
      "projectId",
      "projectGitUrl",
      "worktree",
      "worktreeName",
      "worktreeBaseRef",
    ]
      .filter((key) => raw[key] !== undefined)
      .map((key) => [key, raw[key]]),
  );
  if (
    readToolStringParam(raw, "worktreeName") ||
    readToolStringParam(raw, "worktreeBaseRef") ||
    (isRecord(raw.placement) && raw.placement.kind === "profile")
  ) {
    corrected.worktree = true;
  }
  return `sessions_spawn(${JSON.stringify({ ...corrected, runtime: "subagent", visible: true })})`;
}
