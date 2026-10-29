import { it } from "vitest";

it("preserves fast-uri security and MCP/Ajv compatibility", async () => {
  // Keep the standalone proof on the native test and static dependency graphs.
  await import("../../scripts/test-security-fast-uri.mjs");
});
