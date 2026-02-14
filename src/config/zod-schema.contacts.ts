import { z } from "zod";
import { ToolPolicySchema } from "./zod-schema.agent-runtime.js";

/**
 * Phone number validation (E.164 format).
 * Must start with "+" followed by digits.
 */
const E164PhoneSchema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "Phone must be E.164 format (e.g., +15551234567)");

/**
 * Contact entry schema.
 */
export const ContactEntrySchema = z
  .object({
    phone: E164PhoneSchema,
    name: z.string().optional(),
    email: z.string().email().optional(),
    notes: z.string().optional(),
    tools: ToolPolicySchema,
  })
  .strict();

/**
 * Contact group schema.
 */
export const ContactGroupSchema = z
  .object({
    members: z
      .array(z.string())
      .min(1, "Group must have at least one member")
      .describe("Entry keys or inline E.164 phone numbers"),
    tools: ToolPolicySchema,
    instructions: z.string().optional(),
  })
  .strict();

/**
 * Root contacts configuration schema.
 */
export const ContactsConfigSchema = z
  .object({
    entries: z.record(z.string(), ContactEntrySchema).optional(),
    groups: z.record(z.string(), ContactGroupSchema).optional(),
  })
  .strict()
  .optional();

export type ContactEntrySchemaType = z.infer<typeof ContactEntrySchema>;
export type ContactGroupSchemaType = z.infer<typeof ContactGroupSchema>;
export type ContactsConfigSchemaType = z.infer<typeof ContactsConfigSchema>;
