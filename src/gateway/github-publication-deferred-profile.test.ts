// Register shared transport mocks before publication owners load.
// oxfmt-ignore
import {
  SESSION_ID,
  SESSION_KEY,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureCanonicalUserProfileForEmail } from "../state/user-profile-writes.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { prepareGitHubPublicationRequesterV2 } from "./github-publication-requester.js";
import {
  createRequesterPublicationFixture,
  guestScopes,
  holdWorkerTurn,
} from "./github-publication-requester.test-support.js";
import { prepareGatewayLocalUserIngress } from "./local-user-ingress.js";
import { WEBSOCKET_OPEN_READY_STATE } from "./server-constants.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";
import { createGatewayConnectProfileLifecycle } from "./server/ws-connection/connect-user-profile.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./server/ws-connection/message-handler-types.js";

const mocks = githubPublicationTestMocks();

function withoutRoles(config: OpenClawConfig): OpenClawConfig {
  const unrestricted = { ...config, gateway: { ...config.gateway, roles: undefined } };
  setRuntimeConfigSnapshot(unrestricted);
  return unrestricted;
}

async function connectWithDeferredProfile(
  config: OpenClawConfig,
  profileId: string,
  scopes: string[],
) {
  const client = createOperatorWsClient({ connId: `deferred-${profileId}`, scopes });
  prepareGatewayConnectOperatorAccess(client);
  const handler = {
    connId: client.connId,
    socket: { readyState: WEBSOCKET_OPEN_READY_STATE },
    connectionWork: new AbortController(),
    isClosed: () => false,
    getClient: () => client,
    buildRequestContext: () => ({}),
    setCloseCause: vi.fn(),
    close: vi.fn(),
  };
  const lifecycle = createGatewayConnectProfileLifecycle(
    { configSnapshot: config, handler } as unknown as GatewayConnectPhaseContext,
    {
      role: "operator",
      authPolicy: captureGatewayAuthPolicy(config, { role: "operator", authMethod: "token" }),
    } as DeviceAuthorizedGatewayConnect,
  );
  lifecycle.bind(client);
  await lifecycle.attach(profileId, 1, (profile) =>
    prepareGatewayLocalUserIngress({
      authMethod: "tailscale",
      authenticatedUserExpected: true,
      profile,
      isLocalClient: true,
    }),
  );
  return client;
}

describe("GitHub publication after a deferred profile attachment", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each([
    { target: "own", outcome: "published" },
    { target: "foreign", outcome: "UNAVAILABLE" },
  ] as const)(
    "publishes a session-scoped operator's $target session as $outcome",
    async ({ target, outcome }) => {
      const f = await createRequesterPublicationFixture(vi.fn(), "local", {
        sessionId: SESSION_ID,
        sessionKey: SESSION_KEY,
      });
      if (!f.local) {
        throw new Error("Expected a local publication fixture.");
      }
      const workspace = f.local;
      const config = withoutRoles(f.config);
      const profileId =
        target === "own"
          ? f.guestProfile
          : (await ensureCanonicalUserProfileForEmail("publication-foreign@example.test")).id;
      const client = await connectWithDeferredProfile(config, profileId, guestScopes);
      const { loadGatewaySessionEntryReadOnlyInWorker } = await vi.importActual<
        typeof import("./session-utils-store-worker.js")
      >("./session-utils-store-worker.js");
      mocks.loadSession.mockImplementation((key: string, options?: { agentId?: string }) =>
        loadGatewaySessionEntryReadOnlyInWorker({
          cfg: getRuntimeConfig(),
          key,
          ...options,
          readOnly: true,
        }),
      );
      const head = await workspace.git("rev-parse", "HEAD");
      const index = await fs.readFile(path.join(workspace.cwd, ".git/index"));
      const respond = vi.fn();
      const params = { sessionKey: SESSION_KEY, idempotencyKey: `deferred-${target}` };
      await handleGatewayRequest({
        req: { type: "req", id: params.idempotencyKey, method: "sessions.github.publish", params },
        context: {
          ...f.guestSource.context,
          githubPublicationService: f.coordinator,
        } as GatewayRequestContext,
        client,
        isWebchatConnect: () => false,
        respond,
      });
      if (outcome === "published") {
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ status: "published" }),
        );
        expect(workspace.effects).toEqual(["push", "pull_request"]);
      } else {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: outcome }),
        );
        expect(workspace.effects).toEqual([]);
        expect(await workspace.git("rev-parse", "HEAD")).toBe(head);
        expect(await fs.readFile(path.join(workspace.cwd, ".git/index"))).toEqual(index);
      }
    },
  );

  it.each(["kept", "revoked"] as const)(
    "rechecks a queued deferred-profile publication when access is %s before GitHub writes",
    async (access) => {
      const f = await createRequesterPublicationFixture(vi.fn(), "local");
      const config = withoutRoles(f.config);
      const client = await connectWithDeferredProfile(config, f.guestProfile, guestScopes);
      const captured = await prepareGitHubPublicationRequesterV2(
        { client, context: f.guestSource.context },
        { sessionKey: f.session.sessionKey, agentId: "main" },
      );
      onTestFinished(captured.release);
      const claim = await holdWorkerTurn(f);
      const queued = await f.coordinator.requestForSessionV2(
        f.request("deferred-queued", captured.requester),
      );
      expect(queued.status).toBe("requested");
      expect(f.externalWrites).toEqual([]);

      captured.release();
      await f.placements.releaseTurn(claim);
      if (access === "revoked") {
        // The operator adds roles after connect and moves this person to a role without access.
        setRuntimeConfigSnapshot(f.config);
        await f.revoke();
      }
      const restarted = f.restart();
      await restarted.resumeSessionRequests();

      if (access === "kept") {
        expect(await restarted.readAsync(queued.requestId)).toMatchObject({ status: "published" });
        expect(f.publishedTitles).toEqual(["deferred-queued"]);
      } else {
        expect(await restarted.readAsync(queued.requestId)).toMatchObject({
          status: "failed",
          code: "identity_changed",
        });
        expect(f.externalWrites).toEqual([]);
      }
    },
  );
});
