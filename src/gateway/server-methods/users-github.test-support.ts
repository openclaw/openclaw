import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SecretInput } from "../../config/types.secrets.js";
import type { GitHubToolIdentityConfig } from "../../config/types.tools.js";
import type {
  NativeGitHubIdentityScope,
  NativeGitHubToolAccount,
} from "../../plugin-sdk/native-github-account-host.js";
import type {
  ExecutionEnvironmentPreparationV1,
  PreparedExecutionEnvironment,
} from "../../plugins/execution-environment-types.js";
import { resolveCommandEnv } from "../../process/exec-spawn.js";
import type { UserProfile } from "../../state/user-profiles.types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import type { GatewayClient } from "./types.js";

const network = vi.hoisted(() => ({
  resolveExecutable: vi.fn<typeof import("../../infra/executable-path.js").resolveExecutablePath>(),
  start: vi.fn(),
  poll: vi.fn(),
  refresh: vi.fn(),
  verify: vi.fn<
    (
      token: string,
      options?: {
        signal?: AbortSignal;
        timeoutMs?: number;
        apiBaseUrl?: string;
        assertCurrent?: () => void | Promise<void>;
        allowStale?: boolean;
      },
    ) => Promise<
      | { status: "available"; account: NativeGitHubToolAccount; scopes: string[]; stale?: true }
      | { status: "unavailable" | "rate_limited" | "unverified" }
    >
  >(),
  command: vi.fn(),
}));
export { network };
// mock-isolation: Keep OAuth HTTP requests synthetic while exercising the real RPC and storage owners.
vi.mock("../../../extensions/github-repositories/oauth-api.js", () => ({
  clearGitHubCredentialVerificationCache: vi.fn(),
  requestGitHubOAuthDeviceCode: network.start,
  pollGitHubOAuthDeviceToken: network.poll,
  refreshGitHubOAuthToken: network.refresh,
  verifyGitHubCredential: network.verify,
}));
// mock-isolation: Personal GitHub RPC tests must not spawn the host GitHub CLI.
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runCommandBuffered: network.command,
}));
// Exercise the plugin's real preflight and error class through its public SDK process boundary.
vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugin-sdk/process-runtime.js")>()),
  resolveExecutablePath: network.resolveExecutable,
}));

export const { readGitHubConfig } = await loadBundledPluginFacade<{
  readGitHubConfig(config: OpenClawConfig): {
    service?: { host?: string; token?: SecretInput };
    system?: GitHubToolIdentityConfig;
    agents?: Record<string, GitHubToolIdentityConfig>;
  };
}>({ pluginId: "github-repositories", artifactBasename: "config-api.ts" });
export const {
  prepareGitHubToolEnvironment,
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} = await loadBundledPluginFacade<{
  prepareGitHubToolEnvironment(
    params: Pick<ExecutionEnvironmentPreparationV1, "config" | "agentId">,
  ): PreparedExecutionEnvironment;
  resolveManagedGitHubProfileDir(params: {
    scope: NativeGitHubIdentityScope | "personal";
    agentId: string;
    profileId: string;
  }): string;
  writeManagedGitHubProfileFiles(
    profileDir: string,
    identity: { login: string; token: string },
  ): Promise<void>;
}>({ pluginId: "github-repositories", artifactBasename: "tool-identity-api.ts" });

export const tokens = {
  accessToken: "synthetic-access",
  tokenType: "bearer" as const,
  scopes: ["gist", "read:org", "repo", "workflow"],
  expiresInSeconds: 28800,
  refreshToken: "synthetic-refresh",
  refreshTokenExpiresInSeconds: 15552000,
};

export function resetPersonalGitHubNetwork() {
  network.resolveExecutable.mockReset().mockReturnValue("gh");
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
    const personalTokens = [tokens.accessToken, "synthetic-rotated-access", "new-access"];
    if (!native && !personalTokens.includes(token)) {
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

export function createGitHubTestClient(
  profile: UserProfile,
  email: string,
  scopes: string[],
): GatewayClient {
  return {
    connId: `connection-${profile.id}`,
    authenticatedUserId: email,
    authenticatedUserProfile: gatewayProfile(profile.id, profile.displayName, profile.updatedAt),
    connect: gatewayConnect(scopes, { id: "test", mode: "test", version: "1" }),
  };
}

export function useCredentialEnvironment() {
  network.command.mockImplementation(
    async (argv: string[], options: { env?: NodeJS.ProcessEnv }) => {
      const env = resolveCommandEnv({ argv, env: options.env });
      return {
        code: argv[0] === "git" ? 1 : 0,
        stdout: Buffer.from(
          argv[0] === "gh" ? env.GH_TOKEN || env.GITHUB_TOKEN || "synthetic-native" : "",
        ),
        stderr: Buffer.alloc(0),
      };
    },
  );
}
