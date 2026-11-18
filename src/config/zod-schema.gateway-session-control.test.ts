import { expect, it } from "vitest";
import { GatewayConfigSchema } from "./zod-schema.gateway.js";

it("accepts only explicit boolean publication-reader settings", () => {
  for (const value of [undefined, false, true]) {
    expect(
      GatewayConfigSchema.safeParse({ sessionControl: { publicationReadEnabled: value } }).success,
    ).toBe(true);
  }
  for (const value of ["true", 1, null, {}, []]) {
    expect(
      GatewayConfigSchema.safeParse({ sessionControl: { publicationReadEnabled: value } }).success,
    ).toBe(false);
  }
});
