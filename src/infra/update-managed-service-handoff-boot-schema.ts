import { z } from "zod";

export const managedHandoffBootSchema = z.union([
  z.strictObject({
    platform: z.enum(["linux", "darwin"]),
    identity: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i),
  }),
  z.strictObject({
    platform: z.literal("win32"),
    identity: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/),
  }),
  z.strictObject({
    platform: z.literal("freebsd"),
    identity: z.string().regex(/^[a-f0-9]{32}$/),
  }),
]);
