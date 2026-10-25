import { createServer } from "node:http";
import { expect, it } from "vitest";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { clearSecretsRuntimeSnapshot } from "../../secrets/runtime.js";
import { writeSecretStoreEntry } from "../../secrets/store/secret-store.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import { runAuthProbes } from "./list.probe.js";

it("probes account SecretRefs without persisting resolved credentials or sending unresolved refs", async () => {
  const provider = "probe-account-fixture";
  const credential = "synthetic-account-probe-key";
  const state = await createOpenClawTestState({
    label: "probe-account-secrets",
    env: {
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      PROBE_ACCOUNT_KEY: credential,
      PROBE_ACCOUNT_MISSING: undefined,
    },
  });
  const requests: Array<{ path: string | undefined; authorized: boolean }> = [];
  const server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        requests.push({
          path: request.url,
          authorized: request.headers.authorization === `Bearer ${credential}`,
        });
        request.resume();
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const choice of [
          { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null },
          { index: 0, delta: {}, finish_reason: "stop" },
        ]) {
          response.write(
            `data: ${JSON.stringify({
              id: "probe-response",
              object: "chat.completion.chunk",
              created: 1,
              model: "probe-model",
              choices: [choice],
            })}\n\n`,
          );
        }
        response.end("data: [DONE]\n\n");
      }),
  });
  try {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      models: {
        providers: {
          [provider]: {
            api: "openai-completions",
            baseUrl: `http://127.0.0.1:${server.claim.port}/v1`,
            models: [
              {
                id: "probe-model",
                name: "Probe model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 64,
              },
            ],
          },
        },
      },
    };
    await state.writeConfig(cfg);
    await writeSecretStoreEntry({
      scope: { kind: "team" },
      name: "PROBE_ACCOUNT_STORED",
      value: credential,
      kind: "secret",
      updatedBy: "test",
      database: { env: state.env },
    });
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        [`${provider}:inline`]: { type: "api_key", provider, key: credential },
        [`${provider}:env`]: {
          type: "api_key",
          provider,
          keyRef: { source: "env", provider: "default", id: "PROBE_ACCOUNT_KEY" },
        },
        [`${provider}:store`]: {
          type: "api_key",
          provider,
          keyRef: { source: "store", provider: "default", id: "PROBE_ACCOUNT_STORED" },
        },
        [`${provider}:missing`]: {
          type: "api_key",
          provider,
          keyRef: { source: "env", provider: "default", id: "PROBE_ACCOUNT_MISSING" },
        },
      },
    });
    const before = loadPersistedAuthProfileStore(state.agentDir());
    const result = await runAuthProbes({
      cfg,
      agentId: "main",
      agentDir: state.agentDir(),
      workspaceDir: state.workspaceDir,
      providers: [provider],
      modelCandidates: [`${provider}/probe-model`],
      options: { timeoutMs: 10_000, concurrency: 1, maxTokens: 8 },
      stateOwnership: { mode: "exclusive" },
    });

    expect(Object.fromEntries(result.results.map((row) => [row.profileId, row.status]))).toEqual({
      [`${provider}:inline`]: "ok",
      [`${provider}:env`]: "ok",
      [`${provider}:store`]: "ok",
      [`${provider}:missing`]: "unknown",
    });
    expect(result.results.find((row) => row.profileId === `${provider}:missing`)).toMatchObject({
      reasonCode: "unresolved_ref",
    });
    expect(requests).toEqual(
      Array.from({ length: 3 }, () => ({ path: "/v1/chat/completions", authorized: true })),
    );
    expect(loadPersistedAuthProfileStore(state.agentDir())).toEqual(before);
  } finally {
    await resetPreparedModelRuntimeSnapshotsForTest();
    clearSecretsRuntimeSnapshot();
    server.listener.closeAllConnections();
    await server.releaseListener();
    await server.claim.release();
    await state.cleanup();
  }
});
