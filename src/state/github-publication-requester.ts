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
  })
  .refine((value) => value.actor.kind !== "system" || value.grant === null);

type RequesterData = z.infer<typeof requesterSchema>;
export type GitHubPublicationRequesterSnapshot = Readonly<
  Omit<RequesterData, "actor" | "scopes" | "grant"> & {
    actor: Readonly<RequesterData["actor"]>;
    scopes: readonly string[];
    grant: Readonly<
      Omit<NonNullable<RequesterData["grant"]>, "aliasBindingIds"> & {
        aliasBindingIds: readonly string[];
      }
    > | null;
  }
>;

const MAX_REQUESTER_BYTES = 64 * 1024;

function immutableRequester(value: RequesterData): GitHubPublicationRequesterSnapshot {
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
  });
}

/** Only original admission writes this snapshot; its facts never replace current authority. */
export function encodeGitHubPublicationRequester(
  requester: GitHubPublicationRequesterSnapshot,
): string {
  const parsed = requesterSchema.safeParse(requester);
  if (!parsed.success) {
    throw new Error("GitHub publication requester is invalid.");
  }
  const json = JSON.stringify(immutableRequester(parsed.data));
  if (Buffer.byteLength(json, "utf8") > MAX_REQUESTER_BYTES) {
    throw new Error("GitHub publication requester is too large.");
  }
  return json;
}

/** Idempotency names the accepted request; effects still check its original alias bindings. */
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
