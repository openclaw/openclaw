// Register shared transport mocks before publication owners load.
// oxfmt-ignore
import {
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
} from "./github-publication.test-support.js";
import { expect, it, vi } from "vitest";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../config/config.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import {
  createRequesterPublicationFixture,
  guestScopes,
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

installGitHubPublicationTestHarness({
  creatorEmail: "publication-guest@example.test",
  sandbox: "required",
  realWorktree: true,
});

it("allows an operator's own session after deferred profile attachment", async () => {
  const f = await createRequesterPublicationFixture(vi.fn(), "local");
  if (!f.local) {
    throw new Error("Expected a local publication fixture.");
  }
  const profileId = f.guestProfile;
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
  const params = { sessionKey: f.session.sessionKey, idempotencyKey: "deferred-own" };
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
  expect(respond.mock.calls).toEqual([[true, expect.objectContaining({ status: "published" })]]);
  expect(f.local.effects).toEqual(["push", "pull_request"]);
});
