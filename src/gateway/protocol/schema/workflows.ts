import { Type, type Static } from "@sinclair/typebox";

export const WorkflowsGetParamsSchema = Type.Object({}, { additionalProperties: false });
export type WorkflowsGetParams = Static<typeof WorkflowsGetParamsSchema>;

export const WorkflowsSaveParamsSchema = Type.Object(
  {
    workflows: Type.Array(Type.Any()),
  },
  { additionalProperties: false },
);
export type WorkflowsSaveParams = Static<typeof WorkflowsSaveParamsSchema>;
