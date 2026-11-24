import { expect, it } from "vitest";
import { GatewayConfigSchema } from "./zod-schema.gateway.js";

it.each(["publicationReadEnabled", "steeringEnabled", "publicationWriteEnabled"])(
  "accepts only explicit boolean %s settings",
  (key) => {
    for (const value of [undefined, false, true]) {
      expect(GatewayConfigSchema.safeParse({ sessionControl: { [key]: value } }).success).toBe(
        true,
      );
    }
    for (const value of ["true", 1, null, {}, []]) {
      expect(GatewayConfigSchema.safeParse({ sessionControl: { [key]: value } }).success).toBe(
        false,
      );
    }
  },
);
