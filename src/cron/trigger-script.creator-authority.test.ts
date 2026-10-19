import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { registerSandboxBackend } from "../agents/sandbox/backend.js";
import { hashTextSha256 } from "../agents/sandbox/hash.js";
import { ToolSearchRuntime } from "../agents/tool-search-runtime.js";
import { resolveToolSearchConfig } from "../agents/tool-search.js";
import { jsonResult, type AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../state/user-channel-identities.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { createCronScriptRuntime } from "./trigger-script.js";
import type { CronStoredJob } from "./types.js";

const requester = {
  version: 1,
  channel: "slack",
  accountId: "work",
  senderId: "U-CURRENT",
} as const;
const identity = {
  channelId: requester.channel,
  accountId: requester.accountId,
  senderId: requester.senderId,
};
const sessionKey = "agent:main:source";
function job(): CronStoredJob {
  return {
    ...makeCronJob({}),
    id: "creator-script",
    createdActor: { type: "human", source: "channel", id: "U-HISTORICAL" },
    owner: { agentId: "main", sessionKey, accountId: "work" },
    scheduledToolPolicy: {
      version: 1,
      mode: "account",
      ownerSessionKey: sessionKey,
      ownerAccountId: "work",
    },
    toolsAllowProvenance: {
      version: 1,
      source: "authenticated-requester",
      callerOrigin: { kind: "external", channel: "slack" },
      channelRequester: requester,
    },
    payload: { kind: "script", script: "return result", toolsAllow: ["probe"] },
  };
}
const config: OpenClawConfig = {
  gateway: {
    roles: {
      default: "guest",
      definitions: {
        guest: { sessions: { others: "none" }, agents: "*", scopes: [], sandbox: "required" },
        member: { sessions: { others: "none" }, agents: "*", scopes: [] },
      },
    },
  },
};

describe("cron code-mode creator authority", () => {
  it.each(["trigger", "payload"] as const)(
    "%s provisions the canonical creator's required sandbox with agent mode off",
    async (mode) => {
      await withOpenClawTestState(
        { scenario: "minimal", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
        async (state) => {
          const profile = ensureProfileForEmail("sandbox-creator@example.test");
          linkUserChannelIdentity(profile.id, identity);
          using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
          const owner = acquireGatewayStateOwner({
            databasePath: resolveOpenClawStateSqlitePath(),
            payload: {
              pid: process.pid,
              createdAt: new Date().toISOString(),
              configPath: state.configPath,
              role: "gateway",
            },
          });
          const backend = vi.fn<import("../agents/sandbox/backend.js").SandboxBackendFactory>(
            async () => {
              throw new Error("required creator sandbox fixture");
            },
          );
          const restore = registerSandboxBackend("creator-proof", backend);
          const headless = vi.fn<
            NonNullable<Parameters<typeof createCronScriptRuntime>[0]["runHeadless"]>
          >(async () => ({
            status: "completed",
            value: { fire: true },
            output: [],
            toolCallCount: 0,
          }));
          try {
            const runtime = createCronScriptRuntime({
              config: {
                ...config,
                agents: {
                  defaults: {
                    workspace: state.workspaceDir,
                    skipBootstrap: true,
                    sandbox: {
                      mode: "off",
                      backend: "creator-proof",
                      workspaceAccess: "rw",
                      workspaceRoot: state.path("sandboxes"),
                      prune: { idleHours: 0, maxAgeDays: 0 },
                    },
                  },
                },
              },
              loadPluginRegistry: () => createEmptyPluginRegistry(),
              runHeadless: headless,
            });
            const sandboxJob = job();
            sandboxJob.payload.toolsAllow = [];
            const invocation = { job: sandboxJob, deliveryAttemptFence: null };
            const result =
              mode === "trigger"
                ? await runtime.evaluateTrigger({
                    ...invocation,
                    script: "return result",
                    state: null,
                  })
                : await runtime.executePayload(invocation);
            expect(result).toMatchObject({
              kind: "error",
              error: expect.stringContaining("required creator sandbox fixture"),
            });
            expect(headless).not.toHaveBeenCalled();
            expect(backend).toHaveBeenCalledOnce();
            expect(backend.mock.calls[0]?.[0]).toMatchObject({
              scopeKey: expect.stringContaining(
                `principal:${hashTextSha256(profile.id).slice(0, 32)}`,
              ),
              cfg: { workspaceAccess: "ro" },
            });
          } finally {
            restore();
            owner.release();
          }
        },
      );
    },
  );

  for (const mode of ["trigger", "payload"] as const) {
    it.each(["unbound", "revoked", "relinked", "role", "unchanged", "local"] as const)(
      `${mode} fences %s creator authority at the tool boundary`,
      async (change) =>
        withOpenClawTestState({ scenario: "minimal" }, async () => {
          const profile = ensureProfileForEmail("creator@example.test");
          const other = ensureProfileForEmail("other@example.test");
          linkUserChannelIdentity(profile.id, identity);
          using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
          const entered = createDeferred();
          const release = createDeferred();
          const execute = vi.fn(async () => jsonResult({ changed: true }));
          const probe: AnyAgentTool = {
            name: "probe",
            label: "Probe",
            description: "Creator authority effect",
            parameters: { type: "object", properties: {} },
            prepareBeforeToolCallParams: async (args) => {
              entered.resolve();
              await release.promise;
              return args;
            },
            execute,
          };
          const headless = vi.fn<
            NonNullable<Parameters<typeof createCronScriptRuntime>[0]["runHeadless"]>
          >(async ({ ctx }) => {
            const value = await new ToolSearchRuntime(
              ctx,
              resolveToolSearchConfig(ctx.runtimeConfig),
              {
                prepareInput: true,
                validateInput: true,
              },
            ).callValue("probe", {});
            return {
              status: "completed",
              value: { fire: true, state: value },
              output: [],
              toolCallCount: 1,
            };
          });
          const runtime = createCronScriptRuntime({
            config,
            prepareRuntime: async () => ({
              createTools: async () => [probe],
              context: {
                config,
                agentId: "main",
                sessionKey: "agent:main:cron:creator-script:trigger",
              },
            }),
            runHeadless: headless,
          });
          const stored = job();
          if (change === "unbound") {
            delete stored.toolsAllowProvenance;
          } else if (change === "local") {
            stored.toolsAllowProvenance = {
              version: 1,
              source: "authenticated-requester",
              callerOrigin: { kind: "local" },
            };
          }
          const invocation = { job: stored, deliveryAttemptFence: null };
          const pending =
            mode === "trigger"
              ? runtime.evaluateTrigger({ ...invocation, script: "return result", state: null })
              : runtime.executePayload(invocation);
          try {
            if (change === "unbound") {
              release.resolve();
              await expect(pending).resolves.toMatchObject({
                kind: "error",
                error: expect.stringMatching(/reauthoriz/i),
              });
              expect(headless).not.toHaveBeenCalled();
            } else {
              await awaitGateBeforeSettlement(
                entered.promise,
                pending,
                "Script did not reach tool preparation",
              );
              if (change === "revoked") {
                unlinkUserChannelIdentity(profile.id, identity);
              }
              if (change === "relinked") {
                unlinkUserChannelIdentity(profile.id, identity);
                linkUserChannelIdentity(other.id, identity);
              }
              if (change === "role") {
                setUserProfileRole(profile.id, "member");
              }
              release.resolve();
              await expect(pending).resolves.toMatchObject({
                kind:
                  change === "unchanged" || change === "local"
                    ? mode === "trigger"
                      ? "evaluated"
                      : "completed"
                    : "error",
              });
            }
            expect(execute).toHaveBeenCalledTimes(
              change === "unchanged" || change === "local" ? 1 : 0,
            );
          } finally {
            release.resolve();
            await pending;
          }
        }),
    );
  }
});
