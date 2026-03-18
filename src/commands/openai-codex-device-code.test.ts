import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detectBinary: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  readCodexCliCredentials: vi.fn(),
}));

vi.mock("./onboard-helpers.js", () => ({
  detectBinary: mocks.detectBinary,
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../agents/cli-credentials.js", () => ({
  readCodexCliCredentials: mocks.readCodexCliCredentials,
}));

const { extractOpenAICodexEmailFromAccessToken, loginOpenAICodexDeviceCode } =
  await import("./openai-codex-device-code.js");

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function buildJwt(payload: Record<string, unknown>): string {
  return [
    encodeBase64Url(JSON.stringify({ alg: "none", typ: "JWT" })),
    encodeBase64Url(JSON.stringify(payload)),
    "sig",
  ].join(".");
}

describe("extractOpenAICodexEmailFromAccessToken", () => {
  it("reads the OpenAI profile email claim from the access token", () => {
    const accessToken = buildJwt({
      "https://api.openai.com/profile.email": "user@example.com",
    });

    expect(extractOpenAICodexEmailFromAccessToken(accessToken)).toBe("user@example.com");
  });

  it("returns undefined for malformed tokens", () => {
    expect(extractOpenAICodexEmailFromAccessToken("not-a-jwt")).toBeUndefined();
  });
});

describe("loginOpenAICodexDeviceCode", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs codex login --device-auth with mirrored output and imports the resulting credentials", async () => {
    const accessToken = buildJwt({
      "https://api.openai.com/profile.email": "user@example.com",
    });
    mocks.detectBinary.mockResolvedValue(true);
    mocks.runCommandWithTimeout.mockResolvedValue({
      stdout: "device instructions",
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    });
    mocks.readCodexCliCredentials.mockReturnValue({
      type: "oauth",
      provider: "openai-codex",
      access: accessToken,
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct_123",
    });

    const result = await loginOpenAICodexDeviceCode();

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledWith(["codex", "login", "--device-auth"], {
      timeoutMs: 600_000,
      env: { NODE_OPTIONS: "", OPENAI_API_KEY: undefined },
      mirrorStdout: true,
      mirrorStderr: true,
    });
    expect(result).toMatchObject({
      access: accessToken,
      refresh: "refresh-token",
      email: "user@example.com",
      accountId: "acct_123",
    });
  });

  it("fails clearly when codex is not installed", async () => {
    mocks.detectBinary.mockResolvedValue(false);

    await expect(loginOpenAICodexDeviceCode()).rejects.toThrow(
      "Codex CLI not found. Install with: npm install -g @openai/codex",
    );
  });

  it("fails when codex device-auth login exits non-zero", async () => {
    mocks.detectBinary.mockResolvedValue(true);
    mocks.runCommandWithTimeout.mockResolvedValue({
      stdout: "",
      stderr: "bad login",
      code: 1,
      signal: null,
      killed: false,
      termination: "exit",
    });

    await expect(loginOpenAICodexDeviceCode()).rejects.toThrow(
      "Codex CLI device-auth login failed (exit 1).",
    );
  });
});
