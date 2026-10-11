import { afterEach, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture, sessionKey } from "./control-ui-session-pr-access.test-support.js";
import { prepareControlUiSessionPrRead } from "./control-ui-session-pr-read.js";
import { withControlUiSessionPrSource } from "./control-ui-session-pr-source.js";
import { loadControlUiSessionPullRequests } from "./control-ui-session-prs.js";
import { githubJson, pullListItem, requestUrl } from "./control-ui-session-prs.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";

// Broadcasts send one shared pre-encoded buffer per frame; decode before matching text.
function sentText(socket: { send: { mock: { calls: ReadonlyArray<readonly unknown[]> } } }) {
  return socket.send.mock.calls.map(([data]) => String(data)).join("\n");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "keeps a coalesced branch refresh after its first reader retires (forced=%s)",
  async (forced) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.stubEnv("GH_TOKEN", "");
      vi.stubEnv("GITHUB_TOKEN", "");
      const f = await createFixture("operator.read", true);
      const gate = createDeferredCore<Response>();
      const started = createDeferredCore();
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        started.resolve();
        return (await gate.promise).clone();
      });
      try {
        const repository = await getSessionRepositoryWorkspaceStore().create({
          agentId: "main",
          sessionKey,
          url: "https://github.com/synthetic/publication",
          branch: "coalesced-readers",
          assertCurrent: () => {},
        });
        await f.seed(sessionKey, f.profile.id, { repositoryWorkspaceId: repository.workspaceId });
        const secondReader = f.addReader("second-publication-reader");
        const targets = await Promise.all(
          [f.client, secondReader.client].map(async (client) => {
            const capture = await prepareControlUiSessionPrRead({
              client,
              sessionKey,
              getRuntimeConfig,
              getSessionRowProjection: () => getSessionRowProjection(f.context),
              isCurrentClient: () => !client.invalidated,
            });
            const target = await capture?.();
            if (!target) {
              throw new Error("Fixture reader was not admitted");
            }
            return target;
          }),
        );
        const load = (target: (typeof targets)[number], refresh = false) =>
          withControlUiSessionPrSource(target.readSource, (assertSource, sourceIdentity) =>
            loadControlUiSessionPullRequests(
              { sessionKey, refresh },
              {
                fetchImpl,
                read: {
                  target,
                  sourceIdentity,
                  assertCurrent: () => {
                    assertSource();
                    target.assertCurrent?.();
                  },
                },
              },
            ),
          );
        const first = load(targets[0]!);
        const rejected = expect(first).rejects.toThrow("target changed");
        await started.promise;
        const second = load(targets[1]!, forced);
        await Promise.resolve();
        f.client.invalidated = true;
        gate.resolve(
          githubJson([
            pullListItem({
              state: "closed",
              html_url: "https://github.com/synthetic/publication/pull/103469",
              base: { repo: { name: "publication", owner: { login: "synthetic" } } },
            }),
          ]),
        );
        await rejected;
        expect((await second).pullRequests).toMatchObject([{ number: 103469 }]);
        expect(fetchImpl).toHaveBeenCalledTimes(forced ? 2 : 1);
      } finally {
        gate.resolve(githubJson([]));
        await f.close();
      }
    });
  },
);

it("keeps a public session reader outside a same-named private Enterprise repository", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const provider = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(requestUrl(input));
      return githubJson([
        pullListItem({
          state: "closed",
          head: {},
          title: url.hostname === "api.github.com" ? "Public change" : "Private Enterprise secret",
          html_url: `https://${url.hostname === "api.github.com" ? "github.com" : "ghe.example.test"}/synthetic/publication/pull/103469`,
          base: { repo: { name: "publication", owner: { login: "synthetic" } } },
        }),
      ]);
    });
    vi.stubGlobal("fetch", provider);
    const f = await createFixture("operator.read", true);
    try {
      setRuntimeConfigSnapshot({
        ...f.cfg,
        gateway: {
          ...f.cfg.gateway,
          github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
          controlUi: { github: { host: "ghe.example.test", token: "synthetic-enterprise-token" } },
        },
      });
      const privateKey = "agent:main:private-enterprise";
      for (const [key, host, creator] of [
        [sessionKey, "github.com", f.profile.id],
        [privateKey, "ghe.example.test", f.other.id],
      ]) {
        const repository = await getSessionRepositoryWorkspaceStore().create({
          agentId: "main",
          sessionKey: key!,
          url: `https://${host}/synthetic/publication`,
          branch: "guest-change",
          assertCurrent: () => {},
        });
        await f.seed(key!, creator, {
          repositoryWorkspaceId: repository.workspaceId,
          ...(key === privateKey ? { visibility: "draft" } : {}),
        });
      }
      await f.subscribe([sessionKey, privateKey]);
      await f.subscriptions.pollNow();
      const delivered = sentText(f.socket);
      expect(delivered).toContain("Public change");
      expect(delivered).not.toContain("Private Enterprise secret");
      expect(provider).toHaveBeenCalledOnce();
      const [input, options] = provider.mock.calls[0]!;
      expect(new URL(requestUrl(input)).origin).toBe("https://api.github.com");
      expect(new Headers(options?.headers).has("Authorization")).toBe(false);
    } finally {
      await f.close();
    }
  });
});

it("reads an admitted Enterprise session and builds its branch link on that host", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const provider = vi.fn<typeof fetch>(async (input, options) => {
      const url = new URL(requestUrl(input));
      expect(url.origin).toBe("https://ghe.example.test");
      expect(new Headers(options?.headers).get("Authorization")).toBe(
        "Bearer synthetic-enterprise-token",
      );
      return url.pathname.endsWith("/pulls") ? githubJson([]) : githubJson({ fork: false });
    });
    vi.stubGlobal("fetch", provider);
    const f = await createFixture("operator.read", true);
    try {
      setRuntimeConfigSnapshot({
        ...f.cfg,
        gateway: {
          ...f.cfg.gateway,
          github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
          controlUi: { github: { host: "ghe.example.test", token: "synthetic-enterprise-token" } },
        },
      });
      const repository = await getSessionRepositoryWorkspaceStore().create({
        agentId: "main",
        sessionKey,
        url: "https://ghe.example.test/synthetic/publication",
        branch: "guest-change",
        assertCurrent: () => {},
      });
      await f.seed(sessionKey, f.profile.id, { repositoryWorkspaceId: repository.workspaceId });
      await f.subscribe();
      await f.subscriptions.pollNow();
      expect(sentText(f.socket)).toContain(
        "https://ghe.example.test/synthetic/publication/pull/new/guest-change",
      );
      expect(provider).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });
});
