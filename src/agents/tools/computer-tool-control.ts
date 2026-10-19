import { Type } from "typebox";
import { ScreenSnapshotParamsSchema } from "../../plugins/computer-use-contract.js";

/** Gateway-owned desktop arbitration; never forwarded to a computer provider. */
export const ComputerTakeControlParamsSchema = Type.Object(
  {
    action: Type.Literal("__take_control"),
    ...Type.Required(Type.Pick(ScreenSnapshotParamsSchema, ["executionId"])).properties,
  },
  { additionalProperties: false },
);
