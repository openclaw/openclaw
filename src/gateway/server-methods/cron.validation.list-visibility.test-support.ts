import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { callerClient, createCronJob } from "./cron.validation.test-support.js";
import type { GatewayClient } from "./types.js";

type CronContext = { cron: { listPage: unknown } };
type ListVisibilityTestDeps<TContext extends CronContext> = {
  createCronContext: (
    jobs?: ReturnType<typeof createCronJob> | ReturnType<typeof createCronJob>[],
  ) => TContext;
  invokeCron: (
    method: "cron.list",
    params: Record<string, unknown>,
    options?: { context?: TContext; client?: GatewayClient },
  ) => Promise<{ context: TContext; respond: { mock: { calls: unknown[][] } } }>;
  setRuntimeConfig: (config: OpenClawConfig) => void;
  loadGatewaySessionEntry: unknown;
};

export function registerCronListVisibilityTests<TContext extends CronContext>(
  deps: ListVisibilityTestDeps<TContext>,
): void {
  describe("cron.list visibility", () => {
    it("leaves unrestricted cron.list pages unmarked", async () => {
      const { respond } = await deps.invokeCron("cron.list", {
        includeDisabled: true,
        compact: true,
      });
      expect(respond.mock.calls.at(-1)?.[1]).not.toHaveProperty("visibility");
    });

    it("scopes cron.list to the caller agent and marks the view as restricted", async () => {
      const context = deps.createCronContext(createCronJob({ agentId: "ops" }));
      const { respond } = await deps.invokeCron(
        "cron.list",
        { includeDisabled: true, compact: true },
        { context, client: callerClient("ops") },
      );

      expect(context.cron.listPage).toHaveBeenCalledWith(
        expect.objectContaining({ includeDisabled: true, agentId: undefined }),
        expect.any(Function),
      );
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          total: 1,
          jobs: expect.any(Array),
          visibility: {
            mode: "caller",
            restricted: true,
            warning: expect.stringContaining(
              "total, pagination, and snapshotRevision describe this restricted view",
            ),
          },
        }),
        undefined,
      );
    });

    it("marks role-filtered cron.list pages as restricted and re-pages the visible inventory", async () => {
      const profileId = ensureProfileForEmail("cron-role-owner@example.test").id;
      const ownSessionKey = "agent:ops:role-owned";
      const foreignSessionKey = "agent:worker:role-hidden";
      const sessionEntryLoader = deps.loadGatewaySessionEntry as {
        mockImplementation: (implementation: (sessionKey: string) => unknown) => void;
      };
      sessionEntryLoader.mockImplementation((sessionKey: string) => ({
        canonicalKey: sessionKey,
        entry: {
          sessionId: `session-${sessionKey}`,
          createdActor: {
            type: "human",
            source: "profile",
            id: sessionKey === ownSessionKey ? profileId : "cron-role-foreign",
          },
        },
      }));
      deps.setRuntimeConfig({
        gateway: {
          roles: {
            default: "guest",
            definitions: {
              guest: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.read"],
              },
            },
          },
        },
      });
      const client: GatewayClient = {
        connect: { scopes: ["operator.read"] } as GatewayClient["connect"],
        authenticatedUserProfile: {
          profileId,
          displayName: "Role owner",
          hasAvatar: false,
          updatedAt: 1,
        },
      };
      const context = deps.createCronContext([
        createCronJob({
          id: "role-visible",
          agentId: "ops",
          sessionKey: ownSessionKey,
          owner: { agentId: "ops", sessionKey: ownSessionKey },
        }),
        createCronJob({
          id: "role-hidden",
          agentId: "worker",
          sessionKey: foreignSessionKey,
          owner: { agentId: "worker", sessionKey: foreignSessionKey },
        }),
      ]);

      const { respond } = await deps.invokeCron(
        "cron.list",
        { includeDisabled: true, compact: true, limit: 1 },
        { context, client },
      );

      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          total: 1,
          offset: 0,
          limit: 1,
          hasMore: false,
          nextOffset: null,
          jobs: [expect.objectContaining({ id: "role-visible" })],
          visibility: {
            mode: "role",
            restricted: true,
            warning: expect.stringContaining(
              "total, pagination, and snapshotRevision describe this restricted view",
            ),
          },
        }),
        undefined,
      );
      expect(JSON.stringify(respond.mock.calls)).not.toContain("role-hidden");
    });
  });
}
