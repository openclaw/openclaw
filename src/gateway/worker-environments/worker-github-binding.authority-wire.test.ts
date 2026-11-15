import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { RequestFrame } from "../../../packages/gateway-protocol/src/index.js";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { createOperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { PreparedGitHubPublicationIdentity } from "../../agents/github-tool-identity.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  disposeWorkerGitHubEnvironment,
  prepareWorkerGitHubEnvironment,
} from "../../worker/github-binding.runtime.js";
import { createWorkerConnection } from "../../worker/worker-connection.js";
import { readOperatorToolGatewayAuthority } from "../operator-tool-gateway-authority.js";
import { withOperatorToolGatewayAuthority } from "../server-plugin-in-process-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { dispatchWorkerRequest } from "../server/ws-connection/worker-connection-dispatch.js";
import { bindWorkerTurnOwner } from "./placement-turn-claim-events.js";
import * as support from "./service.test-support.js";
import { bindWorkerGitHubTurn } from "./worker-github-binding.js";
import {
  claimAdmission,
  claimTarget,
  seedClaim,
  replaceClaim,
  claimService,
} from "./worker-turn-rpc-fixtures.test-support.js";

// Only the external GitHub account/repository is synthetic. Request authority, its
// retain owner, placement claims, exact worker admission, RPC and sockets are real.
const github = vi.hoisted(() => ({ token: "synthetic-launch-token" }));
vi.mock("../github-publication-availability.js", async (original) => {
  const actual = await original<typeof import("../github-publication-availability.js")>();
  const workspace = {
    kind: "worktree" as const,
    worktree: {
      id: "fixture-worktree",
      repoFingerprint: "fixture-repository",
      branch: "fixture-branch",
    },
  };
  return {
    ...actual,
    prepareGitHubPublicationWorkspaceOwner: async () => ({
      initial: workspace,
      current: () => workspace,
      read: async () => workspace,
      release: () => {},
    }),
    sameGitHubPublicationWorkspace: (left: unknown, right: unknown) => left === right,
    matchesCurrentGitHubPublicationIdentity: () => true,
    prepareCurrentGitHubPublicationIdentity: async () => preparedIdentity(github.token),
  };
});
function preparedIdentity(token: string): PreparedGitHubPublicationIdentity {
  return {
    source: "system-configured",
    account: { login: "fixture-account", accountId: 42, avatarUrl: null },
    env: { GH_TOKEN: token },
    accessExpiresAtMs: Date.now() + 1_000,
  };
}

support.setupWorkerEnvironmentServiceSuite();

it.each(["original caller revoked", "turn reassigned"] as const)(
  "delivers launch and heartbeat credentials after request completion, but not after %s",
  async (revocation) => {
    const { claim, store } = await seedClaim("github-authority-worker", "github-authority-session");
    assert(claim.owner.kind === "worker");
    const build = { ...support.BOOTSTRAP_RECEIPT, protocolFeatures: [...WORKER_PROTOCOL_FEATURES] };
    const environment = support.testState.store.get(claim.owner.environmentId);
    assert(environment);
    const placement = store.get(claim.sessionId);
    assert(placement && environment.bootstrapReceipt);
    await support.testState.store.revokeEnvironmentCredential(environment.environmentId);
    await support.testState.store.refreshBootstrapReceipt({
      environmentId: environment.environmentId,
      expectedOwnerEpoch: environment.ownerEpoch,
      expectedState: "attached",
      expectedNodeDeviceId: environment.nodeDeviceId,
      expectedBootstrapReceipt: environment.bootstrapReceipt,
      expectedPlacementGeneration: placement.generation,
      bootstrapReceipt: build,
      assertCurrent: () => {},
    });
    const service = claimService(store, {
      prepareInstallation: async () => ({ ...support.BUNDLE_ARTIFACT, ...build }),
    });
    const instance = createOperationalRunInstanceRef(claim.runId);
    const runAuthority = claimAgentRunDelegatedAuthority(instance);
    const target = claimTarget(claim.sessionId);
    const profile = ensureProfileForEmail("original-operator@example.test");
    const client = createOperatorClient({ profileId: profile.id, scopes: ["operator.admin"] });
    const context = createContext();
    const requestScope = { client, context, isWebchatConnect: () => false };
    const admitted = await withPluginRuntimeGatewayRequestScope(requestScope, () =>
      withOperatorToolGatewayAuthority(
        {
          scopes: ["operator.admin"],
          operatorRoleActor: { kind: "operator", profileId: profile.id },
        },
        async () => {
          const operator = readOperatorToolGatewayAuthority()?.operatorRunAuthority;
          assert(operator);
          await bindWorkerTurnOwner(
            store,
            claim,
            undefined,
            instance,
            target,
            () => {},
            undefined,
            operator,
          );
          const grant = await bindWorkerGitHubTurn({
            store,
            claim,
            operatorAuthority: operator,
            session: target,
            sessionTarget: target,
            signal: new AbortController().signal,
            assertCurrent: () => {},
            protocolFeatures: WORKER_PROTOCOL_FEATURES,
            fact: {
              available: true,
              github: {
                token: "synthetic-launch-token",
                remoteUrl: "https://github.com/fixture/repository.git",
                login: "fixture-account",
                branch: "fixture-branch",
                gitAuthor: { name: "Fixture", email: "fixture@example.test" },
              },
              identity: preparedIdentity("synthetic-launch-token"),
              workspaceKey: JSON.stringify([
                "worktree",
                "fixture-worktree",
                "fixture-repository",
                "fixture-branch",
              ]),
            },
          });
          assert(grant);
          return { grant, operator };
        },
      ),
    );
    // The request wrapper has now released its original source reference.
    // The turn receipt scope deliberately does not retain it; the grant must.
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    const delivered: unknown[] = [];
    const credential = await service.acquireTurnCredential(claim);
    const admission = claimAdmission(claim, credential.credential, build);
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        void (async () => {
          const request: RequestFrame = JSON.parse(rawDataToString(raw));
          if (request.method === "connect") {
            const result = await service.admitWorker(admission);
            assert(result.ok, JSON.stringify(result));
            socket.send(
              JSON.stringify({
                type: "res",
                id: request.id,
                ok: true,
                payload: {
                  type: "worker-hello-ok",
                  environmentId: admission.environmentId,
                  sessionId: admission.sessionId,
                  ownerEpoch: admission.ownerEpoch,
                  rpcSetVersion: WORKER_RPC_SET_VERSION,
                  protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
                  credentialExpiresAtMs: Date.now() + 60_000,
                  policy: { heartbeatIntervalMs: 60_000, maxPayload: 25 * 1024 * 1024 },
                },
              }),
            );
            return;
          }
          const result = await service.admitWorker(admission);
          if (!result.ok) {
            socket.send(
              JSON.stringify({
                type: "res",
                id: request.id,
                ok: false,
                error: { code: "UNAVAILABLE", message: result.reason },
              }),
            );
            return;
          }
          await dispatchWorkerRequest({
            request,
            identity: result.identity,
            service,
            connectionId: "fixture-connection",
            send: (frame) => socket.send(JSON.stringify(frame)),
            respond: (ok, payload, error) => {
              delivered.push(payload);
              socket.send(JSON.stringify({ type: "res", id: request.id, ok, payload, error }));
            },
            close: (code, reason) => socket.close(code, reason),
            warn: () => {},
          });
        })().catch((error: unknown) => {
          socket.close(1011, String(error).slice(0, 100));
        });
      });
    });
    const connection = createWorkerConnection({
      endpoint: { kind: "websocket", url: "ws://127.0.0.1:" + address.port },
      admissionTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      connectParams: {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        role: "worker",
        client: {
          id: GATEWAY_CLIENT_IDS.WORKER,
          version: "fixture",
          platform: process.platform,
          mode: GATEWAY_CLIENT_MODES.WORKER,
        },
        admission,
      },
    });
    let installed: Awaited<ReturnType<typeof prepareWorkerGitHubEnvironment>>;
    try {
      await connection.start();
      // Initial launch credential crosses a real local transport before the
      // production worker credential owner installs it on disk.
      admitted.grant.assertCurrent();
      const launchSocket = new WebSocket("ws://127.0.0.1:" + address.port);
      await once(launchSocket, "open");
      const peer = [...server.clients].find((candidate) => candidate !== [...server.clients][0]);
      assert(peer);
      const launch = once(launchSocket, "message");
      admitted.grant.assertCurrent();
      peer.send(JSON.stringify(admitted.grant.binding));
      const [raw] = await launch;
      launchSocket.close();
      installed = await prepareWorkerGitHubEnvironment({
        binding: JSON.parse(rawDataToString(raw)),
        stateDir: support.testState.root,
        turnId: claim.claimId,
        cwd: support.testState.root,
      });
      assert(installed);
      const profileDir = installed.localIdentityEnv?.GH_CONFIG_DIR;
      assert(profileDir);
      const tokenFile = path.join(profileDir, "hosts.yml");
      expect(await fs.readFile(tokenFile, "utf8")).toContain("synthetic-launch-token");
      github.token = "synthetic-refreshed-token";
      const response = await connection.rpc.request("heartbeat", {
        sentAtMs: Date.now(),
        status: "busy",
        githubGeneration: 0,
      });
      assert(response.ok);
      const heartbeat = response.payload;
      expect(heartbeat.github?.token).toContain("synthetic-refreshed-token");
      assert(heartbeat.github);
      await installed.refresh(heartbeat.github, () => {});
      expect(await fs.readFile(tokenFile, "utf8")).toContain("synthetic-refreshed-token");
      if (revocation === "original caller revoked") {
        await setCanonicalUserProfileRole(profile.id, "revoked");
      } else {
        await store.releaseTurn(claim);
        await replaceClaim(store, claim, "replacement-claim");
      }
      github.token = "synthetic-forbidden-token";
      const forbidden = connection.rpc.request("heartbeat", {
        sentAtMs: Date.now(),
        status: "busy",
        githubGeneration: 1,
      });
      if (revocation === "turn reassigned") {
        await expect(forbidden).rejects.toThrow();
      } else {
        expect((await forbidden).ok).toBe(false);
      }
      expect(JSON.stringify(delivered)).not.toContain("synthetic-forbidden-token");
      expect(await fs.readFile(tokenFile, "utf8")).toContain("synthetic-refreshed-token");
      expect(() => admitted.grant.assertCurrent()).toThrow();
    } finally {
      await connection.stop();
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await disposeWorkerGitHubEnvironment(support.testState.root, claim.claimId);
      await admitted.grant.revoke();
      releaseAgentRunDelegatedAuthority(runAuthority);
      await store.releaseTurn(claim).catch(() => {});
    }
  },
);
