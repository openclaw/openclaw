import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema logging levels", () => {
  it("accepts valid logging level values for level and consoleLevel", () => {
    expect(
      OpenClawSchema.safeParse({
        logging: {
          level: "debug",
          consoleLevel: "warn",
        },
      }),
    ).toMatchObject({ success: true });
  });

  it("rejects invalid logging level values", () => {
    expect(() =>
      OpenClawSchema.parse({
        logging: {
          level: "loud",
        },
      }),
    ).toThrow();
    expect(() =>
      OpenClawSchema.parse({
        logging: {
          consoleLevel: "verbose",
        },
      }),
    ).toThrow();
  });
});
