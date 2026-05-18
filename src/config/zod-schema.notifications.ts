import { z } from "zod";

export const NotificationWakePolicyConfigSchema = z
  .object({
    reactions: z.enum(["inherit", "off", "queue", "wake"]).optional(),
  })
  .strict()
  .optional();

export const NotificationsSchema = z
  .object({
    systemEvents: NotificationWakePolicyConfigSchema,
  })
  .strict()
  .optional();
