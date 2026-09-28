import { expectDefined } from "@openclaw/normalization-core";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { readToolOutputSchemaVariants } from "../../agents/schema/tool-output-schema.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
        { includeDisabled: true, compact: true, includeVisibility: true },
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

    it("marks role-restricted cron.list responses through the handler", async () => {
      const profileId = "cron-list-limited-operator";
      const client: GatewayClient = {
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: {
            id: "openclaw-control-ui",
            version: "test",
            platform: "test",
            mode: "webchat",
          },
          role: "operator",
          scopes: ["operator.read"],
        },
        authenticatedUserProfile: {
          profileId,
          displayName: profileId,
          hasAvatar: false,
          updatedAt: 1,
        },
        preparedSessionProfile: {
          profileId,
          aliases: new Set([profileId]),
          role: "limited",
        },
      };
      deps.setRuntimeConfig({
        gateway: {
          roles: {
            default: "limited",
            definitions: {
              limited: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.read"],
              },
            },
          },
        },
      });

      try {
        const { respond } = await deps.invokeCron(
          "cron.list",
          { includeDisabled: true, compact: true, includeVisibility: true },
          { client },
        );
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            visibility: expect.objectContaining({ mode: "role", restricted: true }),
          }),
          undefined,
        );
      } finally {
        deps.setRuntimeConfig({});
      }
    });

    it("keeps the scoped response valid for older strict Code Mode clients", async () => {
      const context = deps.createCronContext(createCronJob({ agentId: "ops" }));
      const { respond } = await deps.invokeCron(
        "cron.list",
        { includeDisabled: true, compact: true },
        { context, client: callerClient("ops") },
      );
      const response = expectDefined(
        respond.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined,
        "legacy cron.list response",
      );
      expect(response).toMatchObject({ total: 1, jobs: expect.any(Array) });
      expect(response).not.toHaveProperty("visibility");

      // Older Code Mode clients use the same strict output contract without the
      // additive visibility field. Validate this actual Gateway response against it.
      const outputSchema = expectDefined(createCronTool().outputSchema, "output schema");
      const outputVariants = readToolOutputSchemaVariants(outputSchema);
      const listVariantIndex = outputVariants?.mapping.get("list");
      const listOutputSchema =
        listVariantIndex === undefined ? undefined : outputVariants?.variants[listVariantIndex];
      if (
        !listOutputSchema ||
        typeof listOutputSchema !== "object" ||
        !("properties" in listOutputSchema)
      ) {
        throw new Error("list output schema did not select an object contract");
      }
      const legacyProperties = Object.fromEntries(
        Object.entries(
          (listOutputSchema as { properties: Record<string, unknown> }).properties,
        ).filter(([key]) => key !== "visibility"),
      ) as Record<string, TSchema>;
      const legacyOutputSchema = Type.Object(legacyProperties, { additionalProperties: false });
      expect([...Value.Errors(legacyOutputSchema, response)]).toEqual([]);
    });
  });
}
