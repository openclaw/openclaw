import { z as baseZ, type ZodTypeAny } from "zod";

type LiteralValue = string | number | boolean | null | undefined;

function literalCompat(value: LiteralValue): ZodTypeAny {
  return baseZ.any().refine((candidate) => Object.is(candidate, value), {
    message: `Expected literal ${JSON.stringify(value)}`,
  });
}

// Some test/runtime environments expose a partial `z` object where
// `z.literal` is unexpectedly missing. Keep the normal Zod export shape
// when available, and only provide a narrow compatibility fallback otherwise.
export const z: typeof baseZ =
  typeof (baseZ as typeof baseZ & { literal?: unknown }).literal === "function"
    ? baseZ
    : new Proxy(baseZ, {
        get(target, prop, receiver) {
          if (prop === "literal") {
            return literalCompat;
          }
          return Reflect.get(target, prop, receiver);
        },
      });
