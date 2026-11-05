import type { NodeWorkerComputerInput } from "./node-computer-schemas.js";
import { isNodeWorkerComputerInput } from "./node-computer-validator.generated.js";

export { NodeWorkerComputerCloseParamsSchema } from "./node-computer-schemas.js";
export type { NodeWorkerComputerInput } from "./node-computer-schemas.js";

/** Private carrier for the existing registered Computer Use provider, never arbitrary node commands. */
export function parseNodeWorkerComputerInput(raw?: string | null): NodeWorkerComputerInput {
  if (!raw || Buffer.byteLength(raw, "utf8") > 128 * 1024) {
    throw new Error("INVALID_REQUEST: invalid worker computer request size");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_REQUEST: malformed worker computer request");
  }
  if (!isNodeWorkerComputerInput(value)) {
    throw new Error("INVALID_REQUEST: invalid worker computer request");
  }
  return value;
}
