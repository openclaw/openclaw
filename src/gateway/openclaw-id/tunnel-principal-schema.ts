import { z } from "zod";
import { isMemberRole } from "../../../packages/openclaw-id-protocol/src/statements/validate.js";

const sourceFields = {
  peerKey: z.string().regex(/^iroh:[a-f0-9]{64}$/),
  authority: z.strictObject({
    clawId: z.string().min(1).max(256),
    rootPub: z.string().min(1).max(256),
    listedSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ownerDevice: z.string().min(1).max(256).optional(),
  }),
};

/** Durable sources require the claw/root/listing identity; a bare peer is not recovery evidence. */
export const openClawIdRecoveryPrincipalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner"), ...sourceFields }),
  z.strictObject({ kind: z.literal("node"), ...sourceFields }),
  z.strictObject({
    kind: z.literal("member"),
    ...sourceFields,
    accountId: z.string().min(1).max(256),
    role: z.string().refine(isMemberRole, "Invalid member role name"),
  }),
]);
