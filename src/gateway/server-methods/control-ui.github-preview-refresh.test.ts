import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { clearGitHubCredentialVerificationCache } from "../../agents/github-oauth-client.js";
import * as githubIdentity from "../../agents/github-tool-identity.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createControlUiRequestOptions } from "./control-ui-request.test-support.js";
import { createControlUiHandlers } from "./control-ui.js";
import { soloClient } from "./sessions-sharing.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

const requestOptions = createControlUiRequestOptions(() => ({}));

describe("GitHub preview background refresh authority", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.for(["unchanged", "removed", "rotated"] as const)(
    "keeps real managed identity checks on stale preview refreshes (%s)",
    async (change, { signal }) => {
      await withOpenClawTestState(
        { layout: "state-only", label: `preview-refresh-${change}` },
        async () => {
          clearGitHubCredentialVerificationCache();
          vi.stubEnv("GH_TOKEN", "");
          vi.stubEnv("GITHUB_TOKEN", "");
          let now = 1_000_000;
          vi.spyOn(Date, "now").mockImplementation(() => now);
          const profileId = `ghp_${"9".repeat(32)}`;
          const cfg: OpenClawConfig = {
            agents: { entries: { main: { tools: { github: { profileId } } } } },
          };
          setRuntimeConfigSnapshot(cfg);
          const profileDir = githubIdentity.resolveManagedGitHubProfileDir({
            agentId: "main",
            scope: "agent",
            profileId,
          });
          const originalToken = "synthetic-preview-refresh-original";
          const replacementToken = "synthetic-preview-refresh-replacement";
          await githubIdentity.writeManagedGitHubProfileFiles(profileDir, {
            login: "preview-fixture",
            token: originalToken,
          });
          const repository = `/repos/openclaw/preview-refresh-${change}`;
          const item = `${repository}/issues/765`;
          const held = createDeferred();
          const release = createDeferred();
          const rejected = createDeferred<unknown>();
          const forbiddenDispatch = createDeferred();
          const refreshed = createDeferred();
          const trace: Array<{ path: string; credential: string }> = [];
          let holdRepository = false;
          let retired = false;
          let refreshing = false;
          let refreshedItem = false;
          const realPrepare = githubIdentity.prepareGitHubReadIdentity;
          vi.spyOn(githubIdentity, "prepareGitHubReadIdentity").mockImplementation(
            async (params) => {
              const identity = await realPrepare(params);
              const revalidate = identity.revalidate;
              return {
                ...identity,
                async revalidate() {
                  try {
                    await revalidate();
                  } catch (error) {
                    if (retired) {
                      rejected.resolve(error);
                    }
                    throw error;
                  }
                },
              };
            },
          );
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async (input, init) => {
              const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
              const authorization = new Headers(init?.headers).get("Authorization");
              const credential =
                authorization === `Bearer ${originalToken}`
                  ? "original"
                  : authorization === `Bearer ${replacementToken}`
                    ? "replacement"
                    : "unexpected";
              trace.push({ path, credential });
              if (retired && credential === "original") {
                forbiddenDispatch.resolve();
              }
              if (path === "/user") {
                return Response.json({ id: 765, login: "preview-fixture", avatar_url: null });
              }
              if (path === repository) {
                if (holdRepository) {
                  holdRepository = false;
                  refreshing = true;
                  held.resolve();
                  await release.promise;
                } else if (refreshing && refreshedItem) {
                  refreshed.resolve();
                }
                return Response.json({ id: 765, private: false, visibility: "public" });
              }
              if (path === item) {
                refreshedItem = refreshing;
                return Response.json({
                  created_at: "2026-09-01T08:00:00Z",
                  updated_at: "2026-09-01T09:00:00Z",
                  state: "open",
                  title: refreshing ? "Refreshed preview" : "Initial preview",
                  user: { login: "preview-fixture" },
                  repository_url: `https://api.github.com${repository}`,
                });
              }
              throw new Error(`Unexpected synthetic GitHub path: ${path}`);
            }),
          );
          const client = {
            ...soloClient(),
            connId: "preview-refresh-connection",
          };
          const handlers = createControlUiHandlers();
          const rpc = async () => {
            const respond = vi.fn<RespondFn>();
            const params = {
              kind: "issue",
              owner: "openclaw",
              repo: `preview-refresh-${change}`,
              number: 765,
              agentId: "main",
            };
            await handleGatewayRequest({
              ...requestOptions(params, respond, {
                client,
                context: {
                  getRuntimeConfig: () => cfg,
                  getClientConnIds: (filter: (current: GatewayClient) => boolean) =>
                    new Set(filter(client) ? [client.connId] : []),
                },
              }),
              extraHandlers: handlers,
            });
            expect(respond).toHaveBeenCalledOnce();
            const [ok, payload] = expectDefined(respond.mock.calls[0], "preview RPC response");
            return { ok, payload };
          };
          try {
            expect(await rpc()).toMatchObject({ ok: true, payload: { title: "Initial preview" } });
            now += 60_001;
            holdRepository = true;
            const staleRequest = rpc();
            await withinTest(held.promise, signal);
            expect(await withinTest(staleRequest, signal)).toMatchObject({
              ok: true,
              payload: { title: "Initial preview", stale: true },
            });
            if (change === "removed") {
              await githubIdentity.removeManagedGitHubProfile(profileDir);
            } else if (change === "rotated") {
              await githubIdentity.refreshManagedGitHubProfile({
                profileDir,
                token: replacementToken,
                expectedAccountId: 765,
              });
            }
            const afterChange = trace.length;
            retired = change !== "unchanged";
            release.resolve();
            if (retired) {
              const failure = await withinTest(
                Promise.race([
                  rejected.promise,
                  forbiddenDispatch.promise.then(() => {
                    throw new Error("Retired credential reached GitHub");
                  }),
                ]),
                signal,
              );
              expect(failure).toMatchObject({ reason: "changed" });
              expect(trace.slice(afterChange)).toEqual([]);
            } else {
              await withinTest(refreshed.promise, signal);
              expect(trace.slice(afterChange)).toEqual([
                { path: item, credential: "original" },
                { path: repository, credential: "original" },
              ]);
            }
            console.log(
              "github-preview-refresh-authority",
              JSON.stringify({ change, requestsAfterChange: trace.slice(afterChange) }),
            );
          } finally {
            release.resolve();
            clearGitHubCredentialVerificationCache();
          }
        },
      );
    },
  );
});
