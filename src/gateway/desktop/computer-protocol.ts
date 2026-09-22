import { z } from "zod";

const command = z.enum(["screen.snapshot", "computer.act"]);
export type ComputerHostCommand = z.infer<typeof command>;
const executionCloseSchema = z.strictObject({
  executionId: z.string().min(1),
  reason: z.string().min(1).max(64),
});
export type ComputerHostExecutionClose = z.infer<typeof executionCloseSchema>;

/** The helper and its owned processes are gone, but provider finalization failed. */
export class ComputerHostFinalizationError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "ComputerHostFinalizationError";
  }
}

const inputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start"), pluginIds: z.array(z.string().min(1)).min(1) }),
  z.strictObject({
    type: z.literal("invoke"),
    id: z.string().min(1),
    command,
    paramsJSON: z.string(),
    sessionKey: z.string().optional(),
  }),
  z.strictObject({ type: z.literal("cancel"), id: z.string().min(1) }),
  z.strictObject({ type: z.literal("stop"), execution: executionCloseSchema.optional() }),
]);

const outputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), computerUse: z.unknown() }),
  z.strictObject({ type: z.literal("result"), id: z.string(), payload: z.string() }),
  z.strictObject({ type: z.literal("error"), id: z.string().optional(), message: z.string() }),
]);

export type ComputerHostInput = z.infer<typeof inputSchema>;
export type ComputerHostOutput = z.infer<typeof outputSchema>;
export const parseComputerHostInput = (value: unknown) => inputSchema.parse(value);
export const parseComputerHostOutput = (value: unknown) => outputSchema.parse(value);
