import { z } from "zod";

const entryFields = {
  path: z.string(),
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  dev: z.string(),
  ino: z.string(),
};
const UpdateCandidatePluginEntrySchema = z.discriminatedUnion("kind", [
  z.object({ ...entryFields, kind: z.literal("directory") }),
  z.object({
    ...entryFields,
    kind: z.literal("file"),
    birthtimeNs: z.string(),
    mtimeNs: z.string(),
    ctimeNs: z.string(),
  }),
  z.object({
    ...entryFields,
    kind: z.literal("symlink"),
    link: z.string(),
    linkType: z.enum(["file", "junction"]),
  }),
]);
export type UpdateCandidatePluginEntry = z.infer<typeof UpdateCandidatePluginEntrySchema>;

export const UpdateCandidatePluginTreePlanSchema = z.object({
  bytes: z.number().int().nonnegative(),
  privateRoot: z.string(),
  candidateRoot: z.string(),
  copies: z.array(z.tuple([z.string(), z.string()])),
  entries: z.array(UpdateCandidatePluginEntrySchema),
  hostLinks: z.array(z.string()),
  relocations: z.array(z.object({ sourceRoot: z.string(), destinationRoot: z.string() })),
  aliases: z.array(z.tuple([z.string(), z.string()])),
  moduleBindings: z.array(z.tuple([z.string(), z.string()])),
  edges: z.array(z.object({ source: z.string(), target: z.string(), real: z.string() })),
});
export type UpdateCandidatePluginTreePlan = z.infer<typeof UpdateCandidatePluginTreePlanSchema>;
