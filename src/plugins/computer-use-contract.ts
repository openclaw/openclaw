import {
  COMPUTER_CONTRACT_MISMATCH,
  type ComputerActParams,
  type ComputerActResult,
  type ComputerUseCapabilityDescriptor,
  type ScreenSnapshotParams,
  type ScreenSnapshotResult,
} from "./computer-use-schemas.js";
import {
  validateComputerActParams,
  validateComputerActResult,
  validateComputerUseCapabilityDescriptor,
  validateScreenSnapshotParams,
  validateScreenSnapshotResult,
} from "./computer-use-validators.generated.js";

export {
  COMPUTER_ACT_V1_ACTION_NAMES,
  COMPUTER_CONTRACT_MISMATCH,
  COMPUTER_ESCALATION_REASONS,
  COMPUTER_EXECUTION_ID_PATTERN,
  COMPUTER_SCROLL_DIRECTIONS,
  COMPUTER_STALE_OBSERVATION,
  COMPUTER_USE_V1_ACTION_NAMES,
  COMPUTER_USE_V2_ACTION_NAMES,
  ComputerActParamsSchema,
  ComputerActResultSchema,
  ComputerUseCapabilityDescriptorSchema,
  ScreenSnapshotParamsSchema,
  ScreenSnapshotResultSchema,
  type ComputerActParams,
  type ComputerActResult,
  type ComputerUseCapabilityDescriptor,
  type ComputerUseV2ActionName,
  type ScreenSnapshotParams,
  type ScreenSnapshotResult,
} from "./computer-use-schemas.js";

type ComputerUseValidator<Value> = (value: unknown) => value is Value;

function parseParamsJSON<Value>(
  paramsJSON: string | null | undefined,
  validate: ComputerUseValidator<Value>,
): Value {
  let value: unknown;
  try {
    value = JSON.parse(paramsJSON ?? "{}");
  } catch {
    throw new Error("COMPUTER_INVALID_REQUEST: params must be valid JSON");
  }
  if (!validate(value)) {
    throw new Error("COMPUTER_INVALID_REQUEST: invalid params");
  }
  return value;
}

export function parseComputerActParamsJSON(
  paramsJSON: string | null | undefined,
): ComputerActParams {
  return parseParamsJSON(paramsJSON, validateComputerActParams);
}

export function parseScreenSnapshotParamsJSON(
  paramsJSON: string | null | undefined,
): ScreenSnapshotParams {
  return parseParamsJSON(paramsJSON, validateScreenSnapshotParams);
}

/** Validate one provider result envelope. */
export function parseComputerActResult(value: unknown): ComputerActResult {
  if (!validateComputerActResult(value)) {
    throw new Error(`${COMPUTER_CONTRACT_MISMATCH}: invalid computer.act result`);
  }
  return value;
}

/** Validate one bounded Computer Use declaration carried by a node connect. */
export function parseComputerUseCapabilityDescriptor(
  value: unknown,
): ComputerUseCapabilityDescriptor {
  if (!validateComputerUseCapabilityDescriptor(value)) {
    throw new Error(`${COMPUTER_CONTRACT_MISMATCH}: invalid capability descriptor`);
  }
  return value;
}

/** Validate and project a `screen.snapshot` result without retaining unknown fields. */
export function parseScreenSnapshotResult(value: unknown): ScreenSnapshotResult {
  if (!validateScreenSnapshotResult(value)) {
    throw new Error("invalid screen.snapshot payload");
  }
  return {
    format: value.format,
    base64: value.base64,
    ...(value.displayFrameId ? { displayFrameId: value.displayFrameId } : {}),
    ...(value.screenIndex !== undefined ? { screenIndex: value.screenIndex } : {}),
    ...(value.width !== undefined ? { width: value.width } : {}),
    ...(value.height !== undefined ? { height: value.height } : {}),
    ...(value.capturedAtMs !== undefined ? { capturedAtMs: value.capturedAtMs } : {}),
  };
}
