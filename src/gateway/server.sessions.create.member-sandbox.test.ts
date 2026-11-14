import { expect, onTestFinished, test } from "vitest";
import { resolveSandboxContext } from "../agents/sandbox/context.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox/runtime-status.js";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { MEMBER_ROLE_PRESETS } from "./openclaw-id/member-role-presets.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import { setupSessionCreateHandlerTestHarness } from "./server.sessions.create.test-support.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
import { authorizeSessionAgentRun } from "./session-sharing-policy.js";
import { directSessionReq } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupSessionCreateHandlerTestHarness();

test.each([false, true])(
  "stamps member-created sessions and rejects unavailable sandbox provisioning (named roles=%s)",
  async (enforced) => {
    const { storePath } = await createSessionStoreDir();
    const profile = ensureProfileForEmail("member-sandbox@example.test");
    setUserProfileRole(profile.id, "host");
    const cfg: OpenClawConfig = {
      ...getRuntimeConfig(),
      session: { ...getRuntimeConfig().session, store: storePath },
      agents: {
        ...getRuntimeConfig().agents,
        defaults: {
          ...getRuntimeConfig().agents?.defaults,
          sandbox: { mode: "off", backend: "unavailable-member-test" },
        },
      },
      gateway: {
        roles: {
          ...(enforced ? { default: "host" } : {}),
          definitions: {
            ...MEMBER_ROLE_PRESETS,
            guest: {
              sessions: { others: "view" },
              agents: "*",
              scopes: ["operator.sessions.write"],
              sandbox: "required",
            },
            host: { sessions: { others: "write" }, agents: "*", scopes: ["operator.write"] },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    let principal: OpenClawIdTunnelPrincipal = {
      kind: "member",
      peerKey: "iroh:guest",
      accountId: "guest",
      role: "guest",
    };
    setOpenClawIdTunnelPrincipalLookup(() => principal);
    onTestFinished(() => setOpenClawIdTunnelPrincipalLookup(undefined));
    const client: GatewayClient = {
      connect: gatewayConnect(["operator.sessions.write"]),
      authenticatedUserProfile: gatewayProfile(profile.id),
      internal: { openclawIdPrincipal: principal },
    };
    const options = { client, context: { getRuntimeConfig: () => cfg } };
    const key = `agent:main:dashboard:member-${enforced}`;
    const create = await directSessionReq("sessions.create", { agentId: "main", key }, options);
    expect(create.ok, JSON.stringify(create.error)).toBe(true);
    const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    expect(entry).toMatchObject({
      sandbox: "required",
      createdActor: { type: "human", source: "profile", id: profile.id },
    });
    expect(
      resolveSandboxRuntimeStatus({
        cfg,
        agentId: "main",
        sessionKey: key,
        preparedSessionEntry: entry,
      }),
    ).toMatchObject({ sandboxed: true, sandboxRequired: true });
    expect(
      authorizeSessionAgentRun({
        cfg,
        client,
        target: { agentId: "main", canonicalKey: "agent:main:host", entry: {} },
      }),
    ).toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("sandboxed session") });
    await expect(
      resolveSandboxContext({
        config: cfg,
        agentId: "main",
        sessionKey: key,
        workspaceDir: getRuntimeConfig().agents?.defaults?.workspace ?? process.cwd(),
      }),
    ).rejects.toThrow('Sandbox backend "unavailable-member-test" is not registered');
    const forkKey = `${key}-fork`;
    const fork = await directSessionReq(
      "sessions.create",
      { agentId: "main", key: forkKey, parentSessionKey: key, fork: true },
      options,
    );
    expect(fork.ok, JSON.stringify(fork.error)).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey: forkKey, storePath })?.sandbox).toBe(
      "required",
    );

    const spawnKey = `${key}-spawn`;
    const spawned = await directSessionReq(
      "sessions.create",
      { agentId: "main", key: spawnKey, parentSessionKey: key, spawnDepth: 1 },
      {
        ...options,
        client: {
          ...client,
          internal: {
            ...client.internal,
            syntheticClient: true,
            sessionCreation: {
              via: "spawn",
              actor: { type: "agent", id: "main" },
              requesterSessionKey: key,
            },
          },
        },
      },
    );
    expect(spawned.ok, JSON.stringify(spawned.error)).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey: spawnKey, storePath })).toMatchObject({
      sandbox: "required",
      createdActor: { id: profile.id },
    });

    const namedClient: GatewayClient = {
      ...client,
      connect: gatewayConnect(["operator.write"]),
      internal: undefined,
    };
    const hostKey = `${key}-other-signin`;
    const host = await directSessionReq(
      "sessions.create",
      { agentId: "main", key: hostKey },
      { ...options, client: namedClient },
    );
    expect(host.ok, JSON.stringify(host.error)).toBe(true);
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: hostKey, storePath })?.sandbox,
    ).toBeUndefined();

    setUserProfileRole(profile.id, "guest");
    principal = { ...principal, role: "operator" };
    client.internal = { openclawIdPrincipal: principal };
    client.connect.scopes = ["operator.write"];
    const operatorKey = `${key}-operator`;
    const operator = await directSessionReq(
      "sessions.create",
      { agentId: "main", key: operatorKey },
      options,
    );
    expect(operator.ok, JSON.stringify(operator.error)).toBe(true);
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: operatorKey, storePath })?.sandbox,
    ).toBeUndefined();
  },
);
