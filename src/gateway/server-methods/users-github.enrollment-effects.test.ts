// Install synthetic external I/O before loading the personal lifecycle.
// oxfmt-ignore
import { createGitHubTestClient, network, resetPersonalGitHubNetwork } from "./users-github.test-support.js";
import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { resolveManagedGitHubProfileRoot } from "../../agents/github-tool-profile-path.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { readUserGitHubConnectionAsync } from "../../state/user-github-connections.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createPersonalGitHubOAuthLifecycle } from "../github-personal-oauth.js";
import { createContext } from "../server-plugin-in-process-dispatch.test-support.js";
import { preparePersonalProfileAction } from "./personal-profile-authorization.js";
import { preparePersonalGitHubPoll } from "./users-github.authority.test-support.js";

async function withEnrollment(
  run: (fixture: {
    client: ReturnType<typeof createGitHubTestClient>;
    action: Awaited<ReturnType<typeof preparePersonalProfileAction>>;
    lifecycle: ReturnType<typeof createPersonalGitHubOAuthLifecycle>;
    owner: string;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    resetPersonalGitHubNetwork();
    const profile = ensureProfileForEmail("effect-proof@example.test");
    const client = createGitHubTestClient(profile, "effect-proof@example.test", ["operator.read"]);
    const catalog = await prepareUserProfileCatalog();
    const context = createContext();
    context.getClientConnIds = (filter) =>
      new Set(!filter || filter(client) ? [client.connId!] : []);
    const action = await preparePersonalProfileAction({ client, context });
    const lifecycle = createPersonalGitHubOAuthLifecycle();
    try {
      await run({ client, action, lifecycle, owner: profile.id });
    } finally {
      await lifecycle.stop();
      catalog.release();
    }
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["start", "poll"] as const)(
  "withdraws personal %s authority at real OAuth HTTP dispatch",
  async (phase) => {
    await withEnrollment(async ({ client, action, lifecycle, owner }) => {
      const oauth = await vi.importActual<typeof import("../../agents/github-oauth-client.js")>(
        "../../agents/github-oauth-client.js",
      );
      const started = phase === "poll" ? await lifecycle.startAuthorization(action) : undefined;
      if (started) {
        preparePersonalGitHubPoll(owner);
      }
      // Revoke at the lifecycle-to-transport handoff, after its earlier authority guard.
      if (phase === "start") {
        network.start.mockImplementationOnce((options) => {
          client.connect.scopes = ["operator.read.no-credential-enrollment"];
          return oauth.requestGitHubOAuthDeviceCode(options);
        });
      } else {
        network.poll.mockImplementationOnce((options) => {
          client.connect.scopes = ["operator.read.no-credential-enrollment"];
          return oauth.pollGitHubOAuthDeviceToken(options);
        });
      }
      const fetch = vi.fn().mockResolvedValue(
        Response.json(
          phase === "start"
            ? {
                device_code: "d".repeat(40),
                user_code: "ABCD-1234",
                verification_uri: "https://github.com/login/device",
                expires_in: 900,
                interval: 5,
              }
            : { error: "authorization_pending" },
        ),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(
        started
          ? lifecycle.pollAuthorization(action, started.requestId)
          : lifecycle.startAuthorization(action),
      ).rejects.toThrow();
      expect(network[phase]).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
      expect((await readUserGitHubConnectionAsync(owner))?.selection.kind).not.toBe("connected");
    });
  },
);

it("does not materialize or select personal credentials after withdrawal during account verification", async () => {
  await withEnrollment(async ({ client, action, lifecycle, owner }) => {
    const started = await lifecycle.startAuthorization(action);
    preparePersonalGitHubPoll(owner);
    network.verify.mockImplementationOnce(async () => {
      client.connect.scopes = ["operator.read.no-credential-enrollment"];
      return {
        status: "available",
        account: { accountId: 101, login: "synthetic-person", avatarUrl: null },
        scopes: [],
      };
    });
    await expect(lifecycle.pollAuthorization(action, started.requestId)).rejects.toThrow();
    expect(network.verify).toHaveBeenCalledOnce();
    expect((await readUserGitHubConnectionAsync(owner))?.selection.kind).not.toBe("connected");
    const root = resolveManagedGitHubProfileRoot({ scope: "personal", agentId: "" });
    expect(
      await fs.readdir(root).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return [];
        }
        throw error;
      }),
    ).toEqual([]);
  });
});
