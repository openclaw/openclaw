/**
 * Preflight tests for Anthropic Vertex auth presence helpers.
 */
<<<<<<< HEAD
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
=======
import { afterEach, describe, expect, it, vi } from "vitest";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  existsSyncMock.mockImplementation((pathname) => actual.existsSync(pathname));
  readFileSyncMock.mockImplementation((pathname, options) =>
    String(pathname) === "/tmp/vertex-adc.json"
      ? '{"client_id":"vertex-client"}'
      : actual.readFileSync(pathname, options as never),
  );
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

<<<<<<< HEAD
describe("hasAnthropicVertexAvailableAuth ADC preflight", () => {
  beforeEach(() => {
    vi.resetModules();
  });

=======
import { hasAnthropicVertexAvailableAuth } from "./anthropic-vertex-auth-presence.js";

describe("hasAnthropicVertexAvailableAuth ADC preflight", () => {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  afterEach(() => {
    existsSyncMock.mockClear();
    readFileSyncMock.mockClear();
  });

<<<<<<< HEAD
  it("reads explicit ADC credentials without an existsSync preflight", async () => {
    existsSyncMock.mockClear();
    readFileSyncMock.mockClear();
    const { hasAnthropicVertexAvailableAuth } = await import("./anthropic-vertex-auth-presence.js");
=======
  it("reads explicit ADC credentials without an existsSync preflight", () => {
    existsSyncMock.mockClear();
    readFileSyncMock.mockClear();
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    expect(
      hasAnthropicVertexAvailableAuth({
        GOOGLE_APPLICATION_CREDENTIALS: "/tmp/vertex-adc.json",
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(readFileSyncMock).toHaveBeenCalledWith("/tmp/vertex-adc.json", "utf8");
  });
});
