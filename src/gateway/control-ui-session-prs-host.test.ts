import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture, sessionKey } from "./control-ui-session-pr-access.test-support.js";
import { githubJson, pullListItem, requestUrl } from "./control-ui-session-prs.test-support.js";

type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function withReader(run: (fixture: Fixture) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const f = await createFixture("operator.read", true);
    try {
      await run(f);
    } finally {
      await f.close();
    }
  });
}

function publicationPull(host = "github.com", title = "Public change") {
  return pullListItem({
    state: "closed",
    title,
    html_url: `https://${host}/synthetic/publication/pull/103469`,
    base: { repo: { name: "publication", owner: { login: "synthetic" } } },
  });
}

async function seedRepository(
  f: Fixture,
  key = sessionKey,
  host = "ghe.example.test",
  creator = f.profile.id,
) {
  const repository = await getSessionRepositoryWorkspaceStore().create({
    agentId: "main",
    sessionKey: key,
    url: `https://${host}/synthetic/publication`,
    branch: "guest-change",
    assertCurrent: () => {},
  });
  await f.seed(key, creator, {
    repositoryWorkspaceId: repository.workspaceId,
    ...(key !== sessionKey ? { visibility: "draft" } : {}),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("forwards invalidated facts even when the row itself is unchanged", async () => {
  await withReader(async (f) => {
    const changed = vi.fn();
    const stop = f.sessionReads.subscribeChanges(changed);
    try {
      sessionChanges.emit({ sessionKey, facts: { kind: "unchanged" } });
      expect(changed).not.toHaveBeenCalled();
      sessionChanges.emit({
        sessionKey,
        facts: { kind: "unchanged" },
        factsInvalidated: true,
      });
      expect(changed).toHaveBeenCalledExactlyOnceWith({
        kind: "session",
        sessionKey,
        agentId: undefined,
        removed: false,
        lineageChanged: true,
      });
    } finally {
      stop();
    }
  });
});

it.each([false, true])(
  "keeps a coalesced branch refresh after its first reader retires (forced=%s)",
  async (forced) => {
    await withReader(async (f) => {
      const gate = createDeferredCore<Response>();
      const started = createDeferredCore();
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        started.resolve();
        return (await gate.promise).clone();
      });
      vi.stubGlobal("fetch", fetchImpl);
      try {
        await seedRepository(f, sessionKey, "github.com");
        const secondReader = f.addReader("second-publication-reader");
        const targets = await Promise.all(
          [f.client, secondReader.client].map(async (client) => {
            const capture = f.sessionReads.createViewerRead(client.connId!, { sessionKey });
            const target = await capture?.();
            if (!target) {
              throw new Error("Fixture reader was not admitted");
            }
            return target;
          }),
        );
        const first = f.presentation.read(targets[0]!, targets[0]!.assertCurrent);
        const rejected = expect(first).rejects.toThrow("target changed");
        await started.promise;
        const second = forced
          ? (async () => {
              await f.presentation.replace(
                secondReader.client.connId!,
                [sessionKey],
                new Set([sessionKey]),
              );
              const snapshot = f.presentation.readPrepared(targets[1]!, () => false);
              if (!snapshot) {
                throw new Error("Forced native refresh did not publish a snapshot");
              }
              return snapshot;
            })()
          : f.presentation.read(targets[1]!, targets[1]!.assertCurrent);
        await Promise.resolve();
        f.client.invalidated = true;
        gate.resolve(githubJson([publicationPull()]));
        await rejected;
        expect((await second).pullRequests).toMatchObject([{ number: 103469 }]);
        expect(fetchImpl).toHaveBeenCalledTimes(forced ? 2 : 1);
      } finally {
        gate.resolve(githubJson([]));
      }
    });
  },
);

it.each([false, true])(
  "isolates same-named GitHub repositories (Enterprise reader=%s)",
  async (enterprise) => {
    await withReader(async (f) => {
      const provider = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(requestUrl(input));
        if (enterprise) {
          return url.pathname.endsWith("/pulls") ? githubJson([]) : githubJson({ fork: false });
        }
        const isPublic = url.hostname === "api.github.com";
        return githubJson([
          {
            ...publicationPull(
              isPublic ? "github.com" : "ghe.example.test",
              isPublic ? "Public change" : "Private Enterprise secret",
            ),
            head: {},
          },
        ]);
      });
      vi.stubGlobal("fetch", provider);
      setRuntimeConfigSnapshot({
        ...f.cfg,
        plugins: {
          entries: {
            "github-repositories": {
              config: {
                host: "ghe.example.test",
                apiBaseUrl: "https://ghe.example.test/api/v3",
                service: { host: "ghe.example.test", token: "synthetic-enterprise-token" },
              },
            },
          },
        },
      });
      await seedRepository(f, sessionKey, enterprise ? "ghe.example.test" : "github.com");
      const privateKey = "agent:main:private-enterprise";
      if (!enterprise) {
        await seedRepository(f, privateKey, "ghe.example.test", f.other.id);
      }
      await f.subscribe(enterprise ? undefined : [sessionKey, privateKey]);
      await f.subscriptions.pollNow();
      const delivered = f.socket.send.mock.calls.map(([data]) => String(data)).join("\n");
      expect(delivered).toContain(
        enterprise
          ? "https://ghe.example.test/synthetic/publication/pull/new/guest-change"
          : "Public change",
      );
      if (!enterprise) {
        expect(delivered).not.toContain("Private Enterprise secret");
      }
      for (const [input, options] of provider.mock.calls) {
        expect({
          origin: new URL(requestUrl(input)).origin,
          authorization: new Headers(options?.headers).get("Authorization"),
        }).toEqual({
          origin: enterprise ? "https://ghe.example.test" : "https://api.github.com",
          authorization: enterprise ? "Bearer synthetic-enterprise-token" : null,
        });
      }
    });
  },
);
