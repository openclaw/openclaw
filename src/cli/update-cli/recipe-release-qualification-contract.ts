import { z } from "zod";

/** Retained purpose facts, not authority: the signed runner and native machine are reobserved. */
export const releaseQualificationBindingSchema = z.strictObject({
  purpose: z.literal("release-qualification"),
  machineId: z.string().regex(/^[a-f0-9]{32}$/),
  bootId: z.uuid(),
  mountNamespace: z.string().regex(/^mnt:\[[0-9]+\]$/),
  pidNamespace: z.string().regex(/^pid:\[[0-9]+\]$/),
  recipe: z.strictObject({ id: z.string().min(1), revision: z.number().int().positive() }),
});
export type ReleaseQualificationBinding = z.infer<typeof releaseQualificationBindingSchema>;
