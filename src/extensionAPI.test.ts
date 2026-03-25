import * as extensionApi from "openclaw/extension-api";
import { describe, expect, it } from "vitest";

describe("extension-api compat surface", () => {
  it("keeps legacy agent helpers importable", () => {
    expect(typeof extensionApi.runEmbeddedPiAgent).toBe("function");
    expect(typeof extensionApi.resolveAgentDir).toBe("function");
    expect(typeof extensionApi.resolveAgentWorkspaceDir).toBe("function");
    expect(typeof extensionApi.resolveAgentTimeoutMs).toBe("function");
    expect(typeof extensionApi.ensureAgentWorkspace).toBe("function");
  });

  it("keeps legacy defaults and session helpers importable", () => {
    expect(typeof extensionApi.DEFAULT_MODEL).toBe("string");
    expect(typeof extensionApi.DEFAULT_PROVIDER).toBe("string");
    expect(typeof extensionApi.resolveStorePath).toBe("function");
    expect(typeof extensionApi.loadSessionStore).toBe("function");
    expect(typeof extensionApi.saveSessionStore).toBe("function");
    expect(typeof extensionApi.resolveSessionFilePath).toBe("function");
  });
});
