import { type Static, Type } from "typebox";
import { closedObject } from "../../../packages/gateway-protocol/src/schema/closed-object.js";
import { PresenceLocationSchema } from "../../../packages/gateway-protocol/src/schema/presence.js";

export const PresenceLocationResultSchema = closedObject({
  results: Type.Array(
    closedObject({
      ip: Type.String(),
      ...Type.Omit(PresenceLocationSchema, ["source"]).properties,
    }),
    { maxItems: 200 },
  ),
});

export type PresenceLocationResult = Static<typeof PresenceLocationResultSchema>;
