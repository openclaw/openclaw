import { OperatorRefusalError } from "../../../src/gateway/operator-refusal.js";

export function refuseAtToolTime() {
  throw new OperatorRefusalError("role-denies");
}

export class ToolRefusal extends OperatorRefusalError {}

export const isRefusal = (error: unknown) => error instanceof OperatorRefusalError;
