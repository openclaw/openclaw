import { createHash } from "node:crypto";
import { z } from "zod";

const requesterSchema = z
  .strictObject({
    version: z.literal(1),
    actor: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("operator"), profileId: z.string().min(1).max(128) }),
      z.strictObject({ kind: z.literal("system") }),
    ]),
    scopes: z.array(z.string().min(1)),
    grant: z
      .strictObject({
        pluginId: z.string().min(1).max(128),
        grantId: z.uuid(),
        aliasBindingIds: z.array(z.uuid()),
      })
      .nullable(),
    origin: z
      .strictObject({
        agentId: z.string().min(1),
        sessionKey: z.string().min(1),
        sessionId: z.string().min(1),
        lifecycleRevision: z.string().min(1).nullable(),
        runId: z.string().min(1).optional(),
      })
      .optional(),
  })
  .refine((value) => value.actor.kind !== "system" || value.grant === null);

type RequesterData = z.infer<typeof requesterSchema>;
export type GitHubPublicationOrigin = Readonly<NonNullable<RequesterData["origin"]>>;
export type GitHubPublicationRequesterSnapshot = Readonly<
  Omit<RequesterData, "actor" | "scopes" | "grant" | "origin"> & {
    actor: Readonly<RequesterData["actor"]>;
    scopes: readonly string[];
    grant: Readonly<
      Omit<NonNullable<RequesterData["grant"]>, "aliasBindingIds"> & {
        aliasBindingIds: readonly string[];
      }
    > | null;
    origin?: GitHubPublicationOrigin;
  }
>;

const MAX_REQUESTER_BYTES = 64 * 1024;

/** Accepted task requests survive source deletion; a later run never changes their identity. */
export function deriveGitHubPublicationTaskId(
  origin: GitHubPublicationOrigin,
  idempotencyKey: string,
): string {
  const bytes = createHash("sha256")
    .update(
      JSON.stringify([
        "openclaw-github-publication-task",
        origin.agentId,
        origin.sessionKey,
        origin.sessionId,
        origin.lifecycleRevision,
        idempotencyKey,
      ]),
    )
    .digest()
    .subarray(0, 16);
  // UUIDv8 preserves the public request-id format for this application-defined hash.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function immutableRequester(
  value: GitHubPublicationRequesterSnapshot,
): GitHubPublicationRequesterSnapshot {
  return Object.freeze({
    version: 1,
    actor: Object.freeze(value.actor),
    scopes: Object.freeze([...new Set(value.scopes)].toSorted()),
    grant: value.grant
      ? Object.freeze({
          ...value.grant,
          aliasBindingIds: Object.freeze([...new Set(value.grant.aliasBindingIds)].toSorted()),
        })
      : null,
    ...(value.origin
      ? {
          origin: Object.freeze({
            agentId: value.origin.agentId,
            sessionKey: value.origin.sessionKey,
            sessionId: value.origin.sessionId,
            lifecycleRevision: value.origin.lifecycleRevision,
            ...(value.origin.runId ? { runId: value.origin.runId } : {}),
          }),
        }
      : {}),
  });
}

/** Only original admission writes this snapshot; its facts never replace current authority. */
export function encodeGitHubPublicationRequester(
  requester: GitHubPublicationRequesterSnapshot,
): string {
  const json = JSON.stringify(immutableRequester(requester));
  if (Buffer.byteLength(json, "utf8") > MAX_REQUESTER_BYTES) {
    throw new Error("GitHub publication requester is too large.");
  }
  return json;
}

/** Retries retain accepted alias bindings and run attribution; effects still check current authority. */
export function matchesGitHubPublicationRequester(
  original: GitHubPublicationRequesterSnapshot,
  current: GitHubPublicationRequesterSnapshot,
): boolean {
  return (
    encodeGitHubPublicationRequester(original) ===
    encodeGitHubPublicationRequester({
      ...current,
      grant:
        current.grant && original.grant
          ? { ...current.grant, aliasBindingIds: original.grant.aliasBindingIds }
          : current.grant,
      ...(current.origin && original.origin
        ? { origin: { ...current.origin, runId: original.origin.runId } }
        : {}),
    })
  );
}

/** Historical or malformed bindings remain unproven; neither can imply System authority. */
export function decodeGitHubPublicationRequester(
  json: string | null | undefined,
): GitHubPublicationRequesterSnapshot | undefined {
  if (!json || Buffer.byteLength(json, "utf8") > MAX_REQUESTER_BYTES) {
    return undefined;
  }
  try {
    const parsed = requesterSchema.safeParse(JSON.parse(json));
    return parsed.success ? immutableRequester(parsed.data) : undefined;
  } catch {
    return undefined;
  }
}
