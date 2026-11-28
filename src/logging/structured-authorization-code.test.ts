import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redact.js";

describe("structured authorization code redaction", () => {
  it("keeps source text in code fields while masking authorization codes", () => {
    const script = 'const rows = await read({ path: "inbox.json" });';
    expect(redactSecrets({ arguments: { code: script }, oauth: { code: "p4Q6 x7J9" } })).toEqual({
      arguments: { code: script },
      oauth: { code: "***" },
    });
  });
});
