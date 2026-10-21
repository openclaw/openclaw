// Register shared transport mocks before publication owners load.
// oxfmt-ignore
import {
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
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
import { dispatchAuthorizationRequest } from "./server-methods.authorization.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";
import { createGatewayConnectProfileLifecycle } from "./server/ws-connection/connect-user-profile.js";
import type {
  DeviceAuthorizedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./server/ws-connection/message-handler-types.js";

const mocks = githubPublicationTestMocks();

async function createDeferredProfileFixture(foreign = false) {
  const f = await createRequesterPublicationFixture(vi.fn(), "local");
  if (!f.local) {
    throw new Error("Expected a local publication fixture.");
  }
  const profileId = foreign
    ? (await ensureCanonicalUserProfileForEmail("publication-foreign@example.test")).id
    : f.guestProfile;
  const config = { ...f.config, gateway: { ...f.config.gateway, roles: undefined } };
  setRuntimeConfigSnapshot(config);
  const client = createOperatorWsClient({ connId: `deferred-${profileId}`, scopes: guestScopes });
  prepareGatewayConnectOperatorAccess(client);
  const handler = {
    socket: { readyState: WEBSOCKET_OPEN_READY_STATE },
    connectionWork: new AbortController(),
    isClosed: () => false,
    getClient: () => client,
    buildRequestContext: () => ({}),
  };
  const lifecycle = createGatewayConnectProfileLifecycle(
    { configSnapshot: config, handler } as unknown as GatewayConnectPhaseContext,
    {
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
  return { ...f, client, workspace: f.local };
}

installGitHubPublicationTestHarness({
  creatorEmail: "publication-guest@example.test",
  sandbox: "required",
  realWorktree: true,
});

it.each(["own", "foreign"] as const)(
  "allows a deferred operator's own session but rejects foreign sessions: %s",
  async (target) => {
    const f = await createDeferredProfileFixture(target === "foreign");
    const { client, workspace } = f;
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
    const params = { sessionKey: f.session.sessionKey, idempotencyKey: `deferred-${target}` };
    const respond = await dispatchAuthorizationRequest(
      "sessions.github.publish",
      params,
      {
        context: {
          ...f.guestSource.context,
          githubPublicationService: f.coordinator,
        } as GatewayRequestContext,
        client,
      },
      params.idempotencyKey,
    );
    expect(respond.mock.calls).toEqual(
      target === "own"
        ? [[true, expect.objectContaining({ status: "published" })]]
        : [[false, undefined, expect.objectContaining({ code: "UNAVAILABLE" })]],
    );
    expect(workspace.effects).toEqual(target === "own" ? ["push", "pull_request"] : []);
    if (target === "foreign") {
      expect(await workspace.git("rev-parse", "HEAD")).toBe(head);
      expect(await fs.readFile(path.join(workspace.cwd, ".git/index"))).toEqual(index);
    }
  },
);

it.each(["kept", "revoked"] as const)(
  "rechecks a queued deferred-profile publication when access is %s before GitHub writes",
  async (access) => {
    const f = await createDeferredProfileFixture();
    const captured = await prepareGitHubPublicationRequesterV2(
      { client: f.client, context: f.guestSource.context },
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
