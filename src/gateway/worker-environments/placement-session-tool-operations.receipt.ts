import { Type, type Static } from "typebox";

const OperationStartSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("execute"),
    operationSeed: Type.String(),
  }),
  Type.Object({ kind: Type.Literal("completed"), resultJson: Type.String() }),
  Type.Object({ kind: Type.Literal("in-progress") }),
  Type.Object({ kind: Type.Literal("unknown") }),
  Type.Object({ kind: Type.Literal("capacity") }),
  Type.Object({ kind: Type.Literal("conflict") }),
  Type.Object({ kind: Type.Literal("unauthorized") }),
]);
export type WorkerSessionToolOperationStart = Static<typeof OperationStartSchema>;
export const PlacementSessionToolReceiptSchema = Type.Object({
  result: Type.Optional(OperationStartSchema),
  changed: Type.Optional(Type.Boolean()),
  recovered: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  toolNames: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
});
export type PlacementSessionToolReceipt = Static<typeof PlacementSessionToolReceiptSchema>;
