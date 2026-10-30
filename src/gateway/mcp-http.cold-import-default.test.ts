import { describe, it } from "vitest";
import { assertColdImportContextCleared } from "./mcp-http.cold-import.test-support.js";
import "../entry.js";

describe("MCP HTTP listener cold import via default CLI entry", () => {
  it("serves later requests outside the first turn context", assertColdImportContextCleared);
});
