import { readFile } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import {
  operatorMcpOAuthIdentity,
  requesterMcpOAuthIdentity,
} from "../../agents/mcp-oauth-identity.js";
import {
  readMcpOAuthPendingAuthorization,
  readMcpOAuthStore,
  mutateMcpOAuthStore,
  writeMcpOAuthPendingAuthorization,
} from "../../agents/mcp-oauth-store.js";
import * as mcpOAuth from "../../agents/mcp-oauth.js";
import { withMcpOAuthTestLease } from "../../agents/mcp-oauth.test-support.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { setRuntimeConfigSnapshotRefreshHandler } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildLegacyDmAccountAllowlistAdapter } from "../../plugin-sdk/allowlist-config-edit.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { handleConfigCommand } from "./commands-config.js";
import { handleMcpCommand } from "./commands-mcp.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

beforeEach(({ onTestFinished }) => {
  const previous = captureActivePluginRegistrySnapshot();
  onTestFinished(() => {
    rollbackStagedPluginRegistry(previous);
  });
  const discord: ChannelPlugin = {
    ...createChannelTestPluginBase({
      id: "discord",
      config: {
        listAccountIds: () => ["team"],
        resolveAccount: (cfg, accountId) =>
          cfg.channels?.discord?.accounts?.[accountId ?? "team"] ?? {},
        resolveAllowFrom: ({ cfg, accountId }) =>
          cfg.channels?.discord?.accounts?.[accountId ?? "team"]?.allowFrom,
      },
    }),
    allowlist: buildLegacyDmAccountAllowlistAdapter({
      channelId: "discord",
      resolveAccount: ({ cfg, accountId }) =>
        cfg.channels?.discord?.accounts?.[accountId ?? "team"] ?? {},
      normalize: ({ values }) => values.map(String),
      resolveDmAllowFrom: (account) => account.allowFrom,
    }),
  };
  stageActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", plugin: discord, source: "test" }]),
    null,
    "default",
  );
});

const commands = [
  {
    command: '/config set logging.level="debug"',
    handler: handleConfigCommand,
    persistedValue: (cfg: OpenClawConfig) => cfg.logging?.level,
    expected: "debug",
    success: "Config updated",
    revocation: "role",
  },
  {
    command: "/config unset logging.level",
    handler: handleConfigCommand,
    persistedValue: (cfg: OpenClawConfig) => cfg.logging?.level,
    expected: undefined,
    success: "Config updated",
    revocation: "unlink",
  },
  {
    command: '/mcp set fixture={"command":"replacement-mcp"}',
    handler: handleMcpCommand,
    persistedValue: (cfg: OpenClawConfig) => cfg.mcp?.servers?.fixture,
    expected: { command: "replacement-mcp" },
    success: 'MCP server "fixture" saved',
    revocation: "role",
  },
  {
    command: "/mcp unset fixture",
    handler: handleMcpCommand,
    persistedValue: (cfg: OpenClawConfig) => cfg.mcp?.servers?.fixture,
    expected: undefined,
    success: 'MCP server "fixture" removed',
    revocation: "reassign",
  },
  {
    command: "/allowlist add dm --config --account team 200",
    handler: handleAllowlistCommand,
    persistedValue: (cfg: OpenClawConfig) => cfg.channels?.discord?.accounts?.team?.allowFrom,
    expected: ["*", "200"],
    success: "DM allowlist added",
    revocation: "grant",
  },
] as const;

it.each(
  commands.flatMap((command) =>
    [false, true].map((revoke) => Object.assign({}, command, { revoke })),
  ),
)(
  "preserves live owner authority through $command persistence (revoke=$revoke)",
  async ({ command, handler, persistedValue, expected, success, revocation, revoke }) => {
    await withAdminIngress(
      async ({ cfg, admins, context, state }) => {
        cfg.commands = { ...cfg.commands, text: true, config: true, mcp: true };
        cfg.logging = { level: "info" };
        cfg.mcp = { servers: { fixture: { command: "original-mcp" } } };
        await state.writeConfig(cfg);
        const original = await readFile(state.configPath, "utf8");
        const admin = admins[0]!;
        const params = buildCommandTestParams(
          command,
          cfg,
          await context(admin.identity.senderId),
          {
            workspaceDir: state.workspaceDir,
          },
        );
        expect(params.command.senderIsOwner).toBe(true);

        const preparing = createDeferredCore();
        const finishPreparation = createDeferredCore();
        setRuntimeConfigSnapshotRefreshHandler({
          preflight: async () => {
            preparing.resolve();
            await finishPreparation.promise;
          },
          refresh: () => false,
        });
        const pending = handler(params, true).then(
          (result) => ({ result, error: undefined }),
          (error: unknown) => ({ result: undefined, error }),
        );
        try {
          expect(
            await Promise.race([
              preparing.promise.then(() => "preparing"),
              pending.then(() => "finished"),
            ]),
          ).toBe("preparing");
          expect(await readFile(state.configPath, "utf8")).toBe(original);
          if (revoke) {
            if (revocation === "role") {
              setUserProfileRole(admin.profile.id, "member");
            } else if (revocation === "grant") {
              delete cfg.gateway!.auth!.identityScopes!["ada@example.test"];
            } else {
              unlinkUserChannelIdentity(admin.profile.id, admin.identity);
              if (revocation === "reassign") {
                linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
              }
            }
          }
          finishPreparation.resolve();
          const outcome = await pending;
          const persisted = await readFile(state.configPath, "utf8");
          if (revoke) {
            expect(persisted).toBe(original);
            expect(outcome.error).toMatchObject({
              message: expect.stringContaining("authority changed"),
            });
          } else {
            expect(outcome.error).toBeUndefined();
            expect(persistedValue(JSON.parse(persisted) as OpenClawConfig)).toEqual(expected);
            expect(outcome.result?.reply?.text).toContain(success);
          }
        } finally {
          finishPreparation.resolve();
          await pending;
          setRuntimeConfigSnapshotRefreshHandler(null);
        }
      },
      revocation === "grant" ? "identity-grant" : "role",
    );
  },
);

it("finishes accepted MCP removal and OAuth cleanup after the original admin is revoked", async () => {
  await withAdminIngress(async ({ cfg, admins, context, state }) => {
    const serverUrl = "https://mcp.example.test/rpc";
    cfg.commands = { ...cfg.commands, text: true, mcp: true };
    cfg.mcp = {
      servers: {
        fixture: {
          url: serverUrl,
          transport: "streamable-http",
          auth: "oauth",
          oauth: { identity: "per-requester" },
        },
      },
    };
    await state.writeConfig(cfg);
    const admin = admins[0]!;
    const identities = [
      operatorMcpOAuthIdentity("fixture", serverUrl),
      requesterMcpOAuthIdentity("fixture", serverUrl, {
        requesterSenderId: admin.identity.senderId,
        messageChannel: "discord",
        agentAccountId: "team",
      }),
    ];
    for (const identity of identities) {
      await withMcpOAuthTestLease(identity.storeKey, async (lease, storeContext) => {
        const options = { storeKey: identity.storeKey, lease, context: storeContext };
        await mutateMcpOAuthStore(options, {
          kind: "tokens",
          tokens: { access_token: identity.principal, token_type: "Bearer" },
          tokenExpiresAt: undefined,
        });
        await writeMcpOAuthPendingAuthorization(options, `${identity.principal}-callback`);
      });
    }
    const params = buildCommandTestParams(
      "/mcp unset fixture",
      cfg,
      await context(admin.identity.senderId),
      { workspaceDir: state.workspaceDir },
    );
    const cleaningUp = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const clearMcpOAuthServer = mcpOAuth.clearMcpOAuthServer;
    const cleanup = vi
      .spyOn(mcpOAuth, "clearMcpOAuthServer")
      .mockImplementation(async (identity) => {
        cleaningUp.resolve();
        await finishCleanup.promise;
        await clearMcpOAuthServer(identity);
      });
    const pending = handleMcpCommand(params, true).then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error }),
    );
    try {
      expect(
        await Promise.race([
          cleaningUp.promise.then(() => "cleanup"),
          pending.then(() => "finished"),
        ]),
      ).toBe("cleanup");
      const committed = await readFile(state.configPath, "utf8");
      expect((JSON.parse(committed) as OpenClawConfig).mcp?.servers?.fixture).toBeUndefined();
      for (const identity of identities) {
        expect((await readMcpOAuthStore(identity.storeKey)).tokens).toEqual({
          access_token: identity.principal,
          token_type: "Bearer",
        });
        expect(await readMcpOAuthPendingAuthorization(`${identity.principal}-callback`)).toBe(
          identity.storeKey,
        );
      }
      setUserProfileRole(admin.profile.id, "member");
      finishCleanup.resolve();

      const outcome = await pending;
      expect(outcome.error).toBeUndefined();
      expect(outcome.result?.reply?.text).toContain('MCP server "fixture" removed');
      expect(await readFile(state.configPath, "utf8")).toBe(committed);
      for (const identity of identities) {
        expect(await readMcpOAuthStore(identity.storeKey)).toEqual({ credentialState: "cleared" });
        expect(
          await readMcpOAuthPendingAuthorization(`${identity.principal}-callback`),
        ).toBeUndefined();
      }
    } finally {
      finishCleanup.resolve();
      await pending;
      cleanup.mockRestore();
    }
  });
});
