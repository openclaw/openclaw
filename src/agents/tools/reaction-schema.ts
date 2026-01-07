import { type TSchema, Type } from "@sinclair/typebox";

type ReactionSchemaOptions = {
  action?: string;
  ids: Record<string, TSchema>;
  emoji?: TSchema;
  includeRemove?: boolean;
  extras?: Record<string, TSchema>;
};

export function createReactionSchema(options: ReactionSchemaOptions) {
  const schema: Record<string, TSchema> = {
    action: Type.Literal(options.action ?? "react"),
    ...options.ids,
    emoji: options.emoji ?? Type.String(),
  };
  if (options.includeRemove) {
    schema.remove = Type.Optional(Type.Boolean());
  }
  if (options.extras) {
    Object.assign(schema, options.extras);
  }
  return Type.Object(schema);
}
