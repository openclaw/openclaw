import { describe, expect, it } from "vitest";
import { renderPluginSdkApiBaseline } from "./api-baseline.js";

describe("acp-runtime public API contract", () => {
  it("declares the manager getter as an explicit facade", async () => {
    const rendered = await renderPluginSdkApiBaseline({ entrypoints: ["acp-runtime"] });
    const moduleSurface = rendered.baseline.modules.find(
      (candidate) => candidate.entrypoint === "acp-runtime",
    );

    expect(moduleSurface?.exports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          exportName: "AcpSessionManagerFacade",
          kind: "interface",
        }),
        expect.objectContaining({
          declaration: expect.stringContaining("AcpSessionManagerFacade"),
          exportName: "getAcpSessionManager",
          kind: "function",
        }),
      ]),
    );
  });
});
