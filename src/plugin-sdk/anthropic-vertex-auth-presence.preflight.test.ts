/**
 * Preflight tests for Anthropic Vertex auth presence helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    default: {
      ...actual,
      existsSync: existsSyncMock,
      readFileSync: readFileSyncMock,
    },
  };
});

vi.mock("./secret-file-runtime.js", () => ({
  tryReadSecretFileSync: (pathname: string) => readFileSyncMock(pathname, "utf8"),
}));

describe("hasAnthropicVertexAvailableAuth ADC preflight", () => {
  beforeEach(() => {
    vi.resetModules();
    existsSyncMock.mockImplementation(() => false);
    readFileSyncMock.mockImplementation((pathname: string) =>
      pathname === "/tmp/vertex-adc.json" ? '{"client_id":"vertex-client"}' : "",
    );
  });

  afterEach(() => {
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
  });

  it("reads explicit ADC credentials without an existsSync preflight", async () => {
    const { hasAnthropicVertexAvailableAuth } = await import("./anthropic-vertex-auth-presence.js");

    expect(
      hasAnthropicVertexAvailableAuth({
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/vertex-adc.json",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(readFileSyncMock).toHaveBeenCalledWith("/tmp/vertex-adc.json", "utf8");
  });
});
