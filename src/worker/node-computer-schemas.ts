import { type Static, Type } from "typebox";
import {
  ComputerActParamsSchema,
  ComputerUseCapabilityDescriptorSchema,
  ScreenSnapshotParamsSchema,
} from "../plugins/computer-use-schemas.js";

const ExecutionOwnerSchema = Type.Required(Type.Pick(ScreenSnapshotParamsSchema, ["executionId"]));
const ExecutionCloseFields = {
  ...ExecutionOwnerSchema.properties,
  reason: Type.String({ minLength: 1, maxLength: 64 }),
};

export const NodeWorkerComputerCloseParamsSchema = Type.Object(
  { action: Type.Literal("__close_execution"), ...ExecutionCloseFields },
  { additionalProperties: false },
);
export const NodeWorkerComputerInputSchema = Type.Union([
  Type.Object({ operation: Type.Literal("capabilities") }, { additionalProperties: false }),
  Type.Object(
    {
      operation: Type.Literal("snapshot"),
      providerGeneration:
        ComputerUseCapabilityDescriptorSchema.properties.provider.properties.generation,
      params: Type.Intersect([ScreenSnapshotParamsSchema, ExecutionOwnerSchema]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("act"),
      providerGeneration:
        ComputerUseCapabilityDescriptorSchema.properties.provider.properties.generation,
      params: Type.Intersect([ComputerActParamsSchema, ExecutionOwnerSchema]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      operation: Type.Literal("close"),
      ...ExecutionCloseFields,
    },
    { additionalProperties: false },
  ),
]);

export type NodeWorkerComputerInput = Static<typeof NodeWorkerComputerInputSchema>;
