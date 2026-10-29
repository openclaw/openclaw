import { vi } from "vitest";

// Reuse the standalone Node proof without replacing any parser implementation.
// Only test registration changes so native Vitest owns every async assertion.
vi.mock("node:test", async () => {
  const { it } = await import("vitest");
  return { test: it };
});

import "../../scripts/test-security-runtime-parsers.mjs";
