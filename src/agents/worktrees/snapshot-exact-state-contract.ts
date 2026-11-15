import { z } from "zod";

const oid = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
export const exactStateRetirementSchema = z
  .object({
    ownerKind: z.enum(["manual", "session", "workboard"]),
    ownerId: z.string().optional(),
    createdAt: z.number().finite(),
    lastActiveAt: z.number().finite(),
    head: oid,
    branchHead: oid,
    indexSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type ExactStateRetirement = z.infer<typeof exactStateRetirementSchema>;

export type ExactProvisionedSnapshot = {
  algorithm: "sha1" | "sha256";
  files: Array<{ path: string; mode: number | null; size: number; blob?: string }>;
};
