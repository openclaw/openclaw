import path from "node:path";
import { z } from "zod";

// The dedicated launcher selects its installed paths and public tool data. Dynamic
// data is serialized under one name and cannot define environment variables.
const absolutePath = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => path.isAbsolute(value) && !/[\0\r\n]/u.test(value));
const NodeExecutionContextSchema = z.strictObject({
  pathPrepend: z.array(absolutePath.refine((value) => !value.includes(path.delimiter))).optional(),
  gitConfigFile: absolutePath.optional(),
  toolData: z.record(z.string(), z.string()).optional(),
});

export type NodeExecutionContext = z.infer<typeof NodeExecutionContextSchema>;
export const NODE_WORKER_EXECUTION_ENV = "OPENCLAW_NODE_WORKER_EXECUTION";

export function parseNodeExecutionContext(
  value: string | undefined,
): NodeExecutionContext | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return NodeExecutionContextSchema.parse(JSON.parse(value));
  } catch {
    // The launcher may have supplied invalid private input. Keep its contents out of logs.
    throw new Error("Invalid dedicated node worker execution configuration");
  }
}
