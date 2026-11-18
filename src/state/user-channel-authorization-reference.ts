import { z } from "zod";

export const userChannelAuthorizationReferenceSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
});
const commandReferenceSchema = z.union([
  userChannelAuthorizationReferenceSchema,
  userChannelAuthorizationReferenceSchema.extend({ version: z.literal(2) }),
]);
export type CommandOwnerReference = Readonly<z.infer<typeof commandReferenceSchema>>;

export function parseCommandOwnerReference(value: unknown) {
  return commandReferenceSchema.safeParse(value).data;
}

export function parseUserChannelAuthorizationReference(value: unknown) {
  return userChannelAuthorizationReferenceSchema.safeParse(value).data;
}
