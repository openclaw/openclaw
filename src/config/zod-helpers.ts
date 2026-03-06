import { z } from "zod";

export function numberFromEnv(schema: z.ZodNumber) {
  return z.preprocess((value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
    return value;
  }, schema);
}
