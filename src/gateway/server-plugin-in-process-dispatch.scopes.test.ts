import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayTool,
  runWithGatewayToolContinuationContext,
} from "../agents/tools/in-process-gateway.js";
import { dispatchGatewayMethod } from "../plugin-sdk/gateway-method-runtime.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { OperatorScope } from "./operator-scopes.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import type { GatewayClient, GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  dispatchGatewayMethodInProcess,
  withOperatorToolGatewayAuthority,
} from "./server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

describe("synthetic operator scope attenuation", () => {
  it.each([
    { method: "sessions.create", params: { incognito: true }, scope: "dynamic", missing: "admin" },
    {
      method: "sessions.create",
      params: { execNode: "remote" },
      scope: "dynamic",
      missing: "admin",
    },
    {
      method: "sessions.patch",
      params: { permissionMode: "full" },
      scope: "dynamic",
      missing: "admin",
    },
    {
      method: "sessions.patchMany",
      params: { patch: { sandboxMode: "off" } },
      scope: "dynamic",
      missing: "admin",
    },
    {
      method: "sessions.delete",
      params: { key: "agent:main:own" },
      scope: "dynamic",
      missing: "admin",
    },
    { method: "sessions.create", params: {}, scope: "operator.admin", missing: "admin" },
    { method: "sessions.create", params: {}, scope: "operator.approvals", missing: "approvals" },
  ] as const)(
    "keeps $method $params behind its $scope requirement",
    async ({ method, params, scope, missing }) => {
      const handler = vi.fn(({ respond }: GatewayRequestHandlerOptions) => respond(true, {}));
      const context = createContext();
      context.getGatewayMethodRegistry = () =>
        createGatewayMethodRegistry([
          { name: method, scope, owner: { kind: "core", area: "scope-proof" }, handler },
        ]);
      await expect(
        withOperatorToolGatewayAuthority(
          {
            authenticatedUserProfile: {
              profileId: ensureProfileForEmail("scope-owner@example.test").id,
              displayName: null,
              hasAvatar: false,
              updatedAt: 1,
            },
            scopes: ["operator.sessions.write"],
          },
          () =>
            dispatchGatewayMethodInProcess(method, params, {
              forceSyntheticClient: true,
              syntheticScopes: ["operator.write"],
              resolveGatewayContext: () => context,
            }),
        ),
      ).rejects.toThrow(`missing scope: operator.${missing}`);
      expect(handler).not.toHaveBeenCalled();
    },
  );

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
      method: "talk.config",
      requiredScope: "operator.talk.secrets",
      allowedScope: "operator.write",
      allowed: false,
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
      const context = createContext();
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
            profileId: ensureProfileForEmail("scope-owner@example.test").id,
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

describe("registered plugin SDK scope attenuation", () => {
  afterEach(() => resetTestPluginRegistry());

  it.each([
    { original: "read", scoped: "read", effective: "read" },
    { original: "write", scoped: "read", effective: "read" },
    { original: "read", scoped: "write", effective: "read" },
    { original: "read", scoped: "admin", effective: "read" },
    { original: "admin", scoped: "write", effective: "write" },
  ] as const)(
    "retains the original $original source within scoped $scoped authority",
    async ({ original, scoped, effective }) => {
      const context = createContext();
      context.resolveGatewayContext = () => context;
      const identified = createOperatorClient({
        profileName: "scope-proof-operator",
        scopes: [`operator.${original}`],
      });
      const sourceController = new AbortController();
      const current = () => true;
      const source = expectDefined(
        await captureGatewayOperatorRunAuthority({
          client: identified,
          context,
          hasCurrentClientAuthority: current,
          sourceAuthority: {
            signal: sourceController.signal,
            assertCurrent: () => sourceController.signal.throwIfAborted(),
          },
        }),
        "original operator source",
      );
      const releases = [source.release];
      try {
        const scopedClient: GatewayClient = {
          ...identified,
          connect: { ...identified.connect, scopes: [`operator.${scoped}`] },
          internal: { operatorRunAuthority: source.authority },
        };
        const handler = vi.fn(({ respond }: GatewayRequestHandlerOptions) => {
          respond(true, { ok: true });
        });
        const { registry, config } = createPluginRegistryFixture();
        registerVirtualTestPlugin({
          registry,
          config,
          id: "scope-proof",
          name: "Scope proof",
          contracts: { gatewayMethodDispatch: ["authenticated-request"] },
          register(api) {
            api.registerGatewayMethod(
              "scopeProof.outer",
              async ({ params, respond }) => {
                const method = params.write ? "scopeProof.write" : "scopeProof.read";
                const result = await dispatchGatewayMethod(method, {});
                respond(result.ok, result.payload, result.error);
              },
              { scope: "operator.read", profileAccess: "independent" },
            );
          },
        });
        setTestPluginRegistry(registry.registry);
        const methods = createGatewayMethodRegistry(
          [
            ...registry.registry.gatewayMethodDescriptors,
            ...(["read", "write"] as const).map((access) => ({
              name: `scopeProof.${access}`,
              scope: `operator.${access}` as const,
              owner: { kind: "core" as const, area: "scope-proof" },
              profileAccess: "independent" as const,
              handler,
            })),
          ],
          registry.registry,
        );
        context.getGatewayMethodRegistry = () => methods;
        const invoke = (write: boolean) =>
          dispatchGatewayRequestInProcessRaw(
            "scopeProof.outer",
            { write },
            {
              client: scopedClient,
              context,
              methodRegistry: methods,
              hasCurrentClientAuthority: current,
            },
          );

        await expect(invoke(false)).resolves.toMatchObject({ ok: true });
        const nested = expectDefined(handler.mock.calls[0]?.[0], "nested Gateway request");
        const client = expectDefined(nested.client, "scoped Gateway client");
        expect(client.internal?.syntheticClient).not.toBe(true);
        expect(client.connId).toBe(identified.connId);
        expect(client.authenticatedUserProfile).toBe(identified.authenticatedUserProfile);
        expect(client.connect.scopes).toEqual([`operator.${effective}`]);
        expect(nested.hasCurrentClientAuthority).toBe(current);
        const accepted = expectDefined(client.internal?.operatorRunAuthority, "accepted source");
        expect(accepted.profileId).toBe(source.authority.profileId);
        expect(accepted.source).toBe(source.authority.source);
        expect(accepted.scopes).toEqual([`operator.${effective}`]);
        expect(accepted.assertCurrent).not.toThrow();

        const writeResult = await invoke(true);
        expect(writeResult.ok).toBe(effective === "write");
        expect(handler).toHaveBeenCalledTimes(effective === "write" ? 2 : 1);
        if (effective === "read") {
          expect(writeResult.error).toMatchObject({ message: "missing scope: operator.write" });
        }

        const recaptured = expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: { ...client, connect: { ...client.connect, scopes: ["operator.admin"] } },
            context,
          }),
          "later inherited source",
        );
        releases.push(recaptured.release);
        expect(recaptured.authority.scopes).toEqual([`operator.${effective}`]);
        expect(recaptured.authority.source).toBe(source.authority.source);
        expect(recaptured.authority.signal).toBe(source.authority.signal);
        expect(recaptured.authority.assertCurrent).not.toThrow();
        sourceController.abort(new Error("original operator source revoked"));
        expect(recaptured.authority.signal?.aborted).toBe(true);
        await expect(invoke(false)).rejects.toThrow("original operator source revoked");
        expect(handler).toHaveBeenCalledTimes(effective === "write" ? 2 : 1);
      } finally {
        releases.forEach((release) => release());
      }
    },
  );
});

describe("native tool scope provenance", () => {
  afterEach(() => resetTestPluginRegistry());

  it.each<{
    name: string;
    source?: OperatorScope[];
    scoped?: OperatorScope[];
    explicit?: OperatorScope[];
    system?: boolean;
    unbound?: boolean;
    nested?: boolean;
    continuation?: boolean;
    read?: boolean;
    broad?: boolean;
    admin?: boolean;
    denied?: boolean;
  }>([
    { name: "staff write minimum", source: ["operator.write"], broad: true },
    { name: "staff read minimum", source: ["operator.read"], read: true, broad: true },
    { name: "admin minimum", source: ["operator.admin"], broad: true, admin: true },
    { name: "Guest minimum", source: ["operator.sessions.write"] },
    {
      name: "original Guest ceiling",
      source: ["operator.sessions.write"],
      scoped: ["operator.admin"],
    },
    {
      name: "current caller ceiling",
      source: ["operator.admin"],
      scoped: ["operator.sessions.write"],
    },
    {
      name: "explicit session ceiling",
      source: ["operator.admin"],
      explicit: ["operator.sessions.write"],
    },
    { name: "explicit empty ceiling", source: ["operator.admin"], explicit: [], denied: true },
    { name: "scoped System write", source: ["operator.write"], system: true, broad: true },
    { name: "scoped System session write", source: ["operator.sessions.write"], system: true },
    {
      name: "explicit System ceiling",
      source: ["operator.sessions.write"],
      explicit: ["operator.write"],
      system: true,
      denied: true,
    },
    { name: "System without scopes", system: true, denied: true },
    { name: "unbound trusted System route", system: true, unbound: true },
    {
      name: "nested explicit System ceiling",
      source: ["operator.admin"],
      explicit: ["operator.sessions.write"],
      system: true,
      nested: true,
    },
    {
      name: "nested System continuation ceiling",
      source: ["operator.admin"],
      explicit: ["operator.sessions.write"],
      system: true,
      nested: true,
      continuation: true,
    },
  ])("preserves $name through the registered native request", async (testCase) => {
    const requiredScope = testCase.read ? "operator.sessions.read" : "operator.sessions.write";
    const broadScope = testCase.read ? "operator.read" : "operator.write";
    const method = "scopeProof.native";
    const handler = vi.fn(async ({ client, params, respond }: GatewayRequestHandlerOptions) => {
      if (params.nested) {
        const request = () => callAgentToolGatewayRequest({ method, params: {} });
        respond(
          true,
          await (testCase.continuation
            ? runWithGatewayToolContinuationContext(request)
            : request()),
        );
        return;
      }
      expect(client?.connect.scopes?.includes("operator.admin") ?? false).toBe(
        testCase.admin ?? false,
      );
      respond(true, {
        broad: roleScopesAllow({
          role: "operator",
          requestedScopes: [broadScope],
          allowedScopes: client?.connect.scopes ?? [],
        }),
      });
    });
    const { registry, config } = createPluginRegistryFixture();
    registerVirtualTestPlugin({
      registry,
      config,
      id: "scope-proof",
      name: "Scope proof",
      register(api) {
        api.registerGatewayMethod(method, handler, {
          scope: requiredScope,
          profileAccess: "independent",
        });
      },
    });
    setTestPluginRegistry(registry.registry);
    const context = createContext();
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry(registry.registry.gatewayMethodDescriptors, registry.registry);
    const sourceClient = createOperatorClient({
      profileName: "native-scope-owner",
      scopes: testCase.source ?? [],
    });
    const captured = testCase.system
      ? undefined
      : await captureGatewayOperatorRunAuthority({ client: sourceClient, context });
    const client: GatewayClient = testCase.system
      ? createSyntheticPluginRuntimeClient({ operatorRoleActor: { kind: "system" } })
      : { ...sourceClient, internal: { operatorRunAuthority: captured?.authority } };
    client.connect = { ...client.connect, scopes: testCase.scoped ?? testCase.source };
    try {
      await withPluginRuntimeGatewayRequestScope(
        { ...(testCase.unbound ? {} : { client }), context, isWebchatConnect: () => false },
        () => {
          const run = async () => {
            const request = () =>
              callAgentToolGatewayRequest({
                method,
                params: { nested: testCase.nested },
                scopes: testCase.explicit,
              });
            if (testCase.denied) {
              await expect(request()).rejects.toThrow(`missing scope: ${requiredScope}`);
              expect(handler).not.toHaveBeenCalled();
            } else {
              await expect(request()).resolves.toEqual({ broad: testCase.broad ?? false });
            }
            if (testCase.explicit === undefined && !testCase.denied) {
              await expect(callInProcessGatewayTool(method, {})).resolves.toEqual({
                broad: testCase.broad ?? false,
              });
            }
          };
          return testCase.nested
            ? withOperatorToolGatewayAuthority(
                {
                  authenticatedUserProfile: expectDefined(
                    sourceClient.authenticatedUserProfile,
                    "System tool profile",
                  ),
                  operatorRoleActor: { kind: "system" },
                  scopes: testCase.source ?? [],
                },
                run,
              )
            : run();
        },
      );
    } finally {
      captured?.release();
    }
  });

  it.each<{ name: string; scopes: OperatorScope[]; read: boolean }>([
    { name: "empty", scopes: [], read: false },
    { name: "read-only", scopes: ["operator.read"], read: true },
  ])("preserves an unidentified continuation's $name ceiling", async ({ scopes, read }) => {
    const owner = createOperatorClient({ profileId: "unidentified-continuation", scopes });
    const client = {
      ...owner,
      authenticatedUserId: undefined,
      authenticatedUserProfile: undefined,
    };
    const handler = vi.fn(({ respond }: GatewayRequestHandlerOptions) =>
      respond(true, { ok: true }),
    );
    const context = createContext();
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry(
        (["read", "write"] as const).map((access) => ({
          name: `scopeProof.${access}`,
          scope: `operator.${access}` as const,
          owner: { kind: "core" as const, area: "scope-proof" },
          profileAccess: "independent" as const,
          handler,
        })),
      );
    await withPluginRuntimeGatewayRequestScope(
      { client, context, isWebchatConnect: () => false },
      () =>
        runWithGatewayToolContinuationContext(async () => {
          for (const access of ["read", "write"] as const) {
            const request = dispatchGatewayMethodInProcess(
              `scopeProof.${access}`,
              {},
              {
                disableSyntheticClient: true,
                requireScopedClient: true,
              },
            );
            if (access === "read" && read) {
              await expect(request).resolves.toEqual({ ok: true });
            } else {
              await expect(request).rejects.toThrow(`missing scope: operator.${access}`);
            }
          }
        }),
    );
    expect(handler).toHaveBeenCalledTimes(read ? 1 : 0);
  });
});
