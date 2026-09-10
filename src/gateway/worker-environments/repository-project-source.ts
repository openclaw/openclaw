import { normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { MANAGED_GITHUB_PROFILE_ID_PATTERN } from "../../config/github-identity-profile-id.js";
import { parseProjectGitUrl } from "../../projects/project-git-url.js";

const AgentId = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    const normalized = normalizeAgentIdStrict(value);
    return normalized.ok && normalized.value === value;
  });
const AccountId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Identity = z.discriminatedUnion("source", [
  z.object({ source: z.literal("anonymous") }).strict(),
  z.object({ source: z.literal("system-detected"), accountId: AccountId }).strict(),
  z
    .object({
      source: z.literal("system-configured"),
      profileId: z.string().regex(MANAGED_GITHUB_PROFILE_ID_PATTERN),
      accountId: AccountId,
    })
    .strict(),
  z
    .object({
      source: z.literal("agent-override"),
      profileId: z.string().regex(MANAGED_GITHUB_PROFILE_ID_PATTERN),
      accountId: AccountId,
    })
    .strict(),
]);
const Agent = z
  .object({
    agentId: AgentId,
    provenance: z
      .object({
        agentId: AgentId,
        createdVia: z.enum(["operator", "agent", "claw"]),
        creatorAgentId: AgentId.nullable(),
        createdAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine((value) => value.provenance === null || value.provenance.agentId === value.agentId);
const RepositoryProject = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/u),
  baseCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  source: z
    .object({
      kind: z.literal("repository"),
      url: z
        .string()
        .max(2048)
        .refine((value) => parseProjectGitUrl(value)?.url === value),
      repositoryId: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9_+/=-]+$/u),
      owner: z.object({ agent: Agent, identity: Identity }).strict(),
    })
    .strict(),
});

export type RepositoryWorkerProjectSnapshot = z.infer<typeof RepositoryProject>;

/** Public project facts persist; current visibility and access remain admission checks. */
export function readRepositoryWorkerProjectSnapshot(
  value: unknown,
): RepositoryWorkerProjectSnapshot | undefined {
  if (!isRecord(value) || value.source === undefined) {
    return undefined;
  }
  const parsed = RepositoryProject.safeParse(value);
  if (
    Object.keys(value).some(
      (key) => !["key", "baseCommit", "source", "preparation"].includes(key),
    ) ||
    !parsed.success
  ) {
    throw new Error("Worker environment has an invalid repository preparation snapshot");
  }
  return parsed.data;
}
