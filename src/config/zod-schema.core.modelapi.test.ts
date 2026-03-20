import { describe, expect, it } from "vitest";

import { ModelApiSchema } from "./zod-schema.core.js";

describe("ModelApiSchema", () => {
  it("接受 openai-codex-responses", () => {
    expect(ModelApiSchema.parse("openai-codex-responses")).toBe("openai-codex-responses");
  });
});

