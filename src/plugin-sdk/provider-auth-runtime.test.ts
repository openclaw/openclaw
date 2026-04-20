import { describe, expect, it } from "vitest";
import * as providerAuthRuntime from "./provider-auth-runtime.js";

describe("plugin-sdk provider-auth-runtime", () => {
  it("exports the runtime-ready auth helper", () => {
    expect(typeof providerAuthRuntime.getRuntimeAuthForModel).toBe("function");
  });

  it("exports the Codex auth bridge helper", () => {
    expect(typeof providerAuthRuntime.prepareCodexAuthBridge).toBe("function");
  });
});
