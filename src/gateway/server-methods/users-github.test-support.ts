import { vi } from "vitest";

const network = vi.hoisted(() => ({
  assertCli: vi.fn(),
  start: vi.fn(),
  poll: vi.fn(),
  refresh: vi.fn(),
  verify: vi.fn<typeof import("../../agents/github-oauth-client.js").verifyGitHubCredential>(),
  command: vi.fn(),
}));
export { network };
// mock-isolation: Keep OAuth HTTP requests synthetic while exercising the real RPC and storage owners.
vi.mock("../../agents/github-oauth-client.js", () => ({
  clearGitHubCredentialVerificationCache: vi.fn(),
  requestGitHubOAuthDeviceCode: network.start,
  pollGitHubOAuthDeviceToken: network.poll,
  refreshGitHubOAuthToken: network.refresh,
  verifyGitHubCredential: network.verify,
}));
// mock-isolation: Personal GitHub RPC tests must not spawn the host GitHub CLI.
vi.mock("../../process/exec.js", () => ({ runCommandBuffered: network.command }));
vi.mock("../github-cli-preflight.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../github-cli-preflight.js")>();
  return { ...actual, assertGitHubCliAvailable: network.assertCli };
});

export const tokens = {
  accessToken: "synthetic-access",
  tokenType: "bearer" as const,
  scopes: ["gist", "read:org", "repo", "workflow"],
  expiresInSeconds: 28800,
  refreshToken: "synthetic-refresh",
  refreshTokenExpiresInSeconds: 15552000,
};

export function resetPersonalGitHubNetwork() {
  network.assertCli.mockReset();
  network.start.mockReset().mockResolvedValue({
    deviceCode: "d".repeat(40),
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresInSeconds: 900,
    intervalSeconds: 5,
  });
  network.poll.mockReset().mockResolvedValue({ status: "authorized", tokens });
  network.refresh.mockReset().mockResolvedValue({
    status: "refreshed",
    tokens: {
      ...tokens,
      accessToken: "synthetic-rotated-access",
      refreshToken: "synthetic-rotated-refresh",
    },
  });
  network.verify.mockReset().mockImplementation(async (token) => {
    const native = token === "synthetic-native";
    if (
      !native &&
      ![tokens.accessToken, "synthetic-rotated-access", "new-access"].includes(token)
    ) {
      return { status: "unavailable" };
    }
    return {
      status: "available",
      account: {
        accountId: native ? 303 : 101,
        login: native ? "system-bot" : "personal-alice",
        avatarUrl: null,
      },
      scopes: [],
    };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockRejectedValue(new Error("Unexpected credential HTTP request")),
  );
  network.command.mockReset().mockImplementation(async (argv: string[]) => {
    if (argv[0] === "gh" && argv.join(" ") !== "gh auth token --hostname github.com") {
      throw new Error("Unexpected GitHub CLI operation");
    }
    return {
      code: argv[0] === "git" ? 1 : 0,
      stdout: Buffer.from(argv[0] === "gh" ? "synthetic-native\n" : ""),
      stderr: Buffer.alloc(0),
    };
  });
}
