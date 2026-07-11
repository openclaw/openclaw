import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveGatewayServiceEntrypoint } from "./service-layout.js";

describe("resolveGatewayServiceEntrypoint", () => {
  it("resolves a relative entrypoint against an absolute working directory", () => {
    expect(
      resolveGatewayServiceEntrypoint({
        programArguments: ["node", "dist/index.js", "gateway", "run"],
        workingDirectory: "/repo/openclaw",
      }),
    ).toBe(path.join("/repo/openclaw", "dist", "index.js"));
  });

  it("resolves Windows service entrypoints with Windows path semantics", () => {
    expect(
      resolveGatewayServiceEntrypoint({
        programArguments: ["node.exe", "dist\\index.js", "gateway", "run"],
        workingDirectory: "C:\\openclaw",
      }),
    ).toBe("C:\\openclaw\\dist\\index.js");
  });

  it("rejects a relative entrypoint without an absolute service working directory", () => {
    expect(
      resolveGatewayServiceEntrypoint({
        programArguments: ["node", "dist/index.js", "gateway", "run"],
      }),
    ).toBeUndefined();
    expect(
      resolveGatewayServiceEntrypoint({
        programArguments: ["node", "dist/index.js", "gateway", "run"],
        workingDirectory: "./checkout",
      }),
    ).toBeUndefined();
  });
});
