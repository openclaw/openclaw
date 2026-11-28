import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("diagnostics.langfuse", () => {
  it("accepts Langfuse gateway tracing config", () => {
    const result = OpenClawSchema.safeParse({
      diagnostics: {
        langfuse: {
          enabled: true,
          host: "http://langfuse:3000",
          publicKey: "pk-lf-test",
          secretKey: "sk-lf-test",
          environment: "local",
          capturePrompts: false,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});
