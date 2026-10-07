import { describe, it } from "vitest";
import { assertColdImportContextCleared } from "./mcp-http.cold-import-probe.js";
import "../entry.js";

describe("MCP HTTP listener cold import via default CLI entry", () => {
  it("serves later requests outside the first turn context", assertColdImportContextCleared);
});
