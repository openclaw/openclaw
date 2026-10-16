import { Type } from "typebox";
import { SessionsCreateParamsSchema } from "../../../packages/gateway-protocol/src/schema/sessions-create.js";
import { requesterProfileSchema } from "../schema/typebox.js";

/** Destination choices only; identity, adoption, and execution lineage remain host-owned. */
export const SessionsCreateToolSchema = Type.Object(
  {
    user: requesterProfileSchema(),
    message: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Initial work brief. Omit to create an idle session; supplied text must not be blank.",
      }),
    ),
    label: SessionsCreateParamsSchema.properties.label,
    agentId: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Destination agent. Default: the requesting agent.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Absolute Gateway working directory, subject to existing workspace permissions. Omitted uses destination defaults.",
      }),
    ),
    group: SessionsCreateParamsSchema.properties.category,
    model: SessionsCreateParamsSchema.properties.model,
    permissionMode: SessionsCreateParamsSchema.properties.permissionMode,
  },
  { additionalProperties: false },
);
