import { describe, it } from "vitest";
import { assertColdImportContextCleared } from "./mcp-http.cold-import.test-support.js";
import "../index.js";

describe("MCP HTTP listener cold import via legacy CLI entry", () => {
  it("serves later requests outside the first turn context", assertColdImportContextCleared);
});
