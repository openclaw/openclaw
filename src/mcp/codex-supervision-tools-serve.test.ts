// Codex supervision MCP tests cover the retired Supervisor command bridge.
import { describe, expect, it } from "vitest";
import { createCodexSupervisionToolsMcpServer } from "./codex-supervision-tools-serve.js";

describe("createCodexSupervisionToolsMcpServer", () => {
  it("fails closed when the external Codex plugin tools are unavailable", () => {
    expect(() =>
      createCodexSupervisionToolsMcpServer({
        config: {},
        tools: [],
      }),
    ).toThrow("Install or update @openclaw/codex");
  });
});
