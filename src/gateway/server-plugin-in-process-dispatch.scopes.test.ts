import { describe, expect, it, vi } from "vitest";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";

describe("synthetic operator scope attenuation", () => {
  it.each([
    {
      method: "sessions.list",
      requiredScope: "operator.read",
      allowedScope: "operator.write",
      allowed: true,
    },
    {
      method: "talk.session.list",
      requiredScope: "operator.talk",
      allowedScope: "operator.write",
      allowed: true,
    },
    {
      method: "tools.invoke",
      requiredScope: "operator.write",
      allowedScope: "operator.read",
      allowed: false,
    },
    {
      method: "config.set",
      requiredScope: "operator.admin",
      allowedScope: "operator.write",
      allowed: false,
    },
    {
      method: "exec.approval.resolve",
      requiredScope: "operator.approvals",
      allowedScope: "operator.write",
      allowed: false,
    },
    {
      method: "node.pair.approve",
      requiredScope: "operator.pairing",
      allowedScope: "operator.write",
      allowed: false,
    },
  ] as const)(
    "projects $allowedScope for $method without granting unrelated permissions",
    async ({ method, requiredScope, allowedScope, allowed }) => {
      const handler = vi.fn(({ client, respond }: GatewayRequestHandlerOptions) => {
        expect(client?.connect.scopes).toEqual([requiredScope]);
        respond(true, { ok: true });
      });
      const context = {
        trackExecution: trackAsyncWork,
        dedupe: new Map(),
        getRuntimeConfig: () => ({}),
        logGateway: { error: vi.fn(), warn: vi.fn() },
      } as unknown as GatewayRequestContext;
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          {
            name: method,
            scope: requiredScope,
            owner: { kind: "core", area: "scope-proof" },
            handler,
          },
        ]);
      const dispatch = withOperatorToolGatewayAuthority(
        {
          authenticatedUserProfile: {
            profileId: "scope-owner",
            displayName: "Scope owner",
            hasAvatar: false,
            updatedAt: 1,
          },
          scopes: [allowedScope],
        },
        () =>
          dispatchGatewayMethodInProcess(
            method,
            {},
            {
              forceSyntheticClient: true,
              syntheticScopes: [requiredScope, "operator.admin"],
              resolveGatewayContext: () => context,
            },
          ),
      );
      if (allowed) {
        await expect(dispatch).resolves.toEqual({ ok: true });
        expect(handler).toHaveBeenCalledOnce();
      } else {
        await expect(dispatch).rejects.toThrow(`missing scope: ${requiredScope}`);
        expect(handler).not.toHaveBeenCalled();
      }
    },
  );
});
