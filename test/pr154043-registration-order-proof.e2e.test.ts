import { expectDefined } from "@openclaw/normalization-core";
import { materializeRequesterScopedMcpToolsForHarnessRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it } from "vitest";
import {
  createSessionMcpRuntimeManager,
  makeRequesterParams,
} from "../src/agents/agent-bundle-mcp-manager.test-support.js";
import { startRequesterScopedMcpProofServer } from "../src/agents/agent-bundle-mcp-requester.test-support.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "../src/agents/agent-bundle-mcp-runtime-shared.js";
import { testing } from "../src/agents/agent-bundle-mcp-runtime.js";
import { partitionMcpServersByConnectionScope } from "../src/agents/mcp-connection-resolver.js";
import { createMcpProofPluginRegistry } from "../src/agents/mcp-connection-resolver.test-fixtures.js";
import { withPluginRuntimeRegistryScope } from "../src/plugins/runtime/gateway-request-scope.js";

const DECLARED_SERVERS = {
  "user-mail": { transport: "streamable-http" as const, url: "https://placeholder.invalid/mcp" },
};

describe("PR #154043 registration-order proof", () => {
  it.each(["provider-first", "resolver-first"] as const)(
    "keeps the connection resolver authoritative over requester admission (%s)",
    async (order) => {
      const proof = await startRequesterScopedMcpProofServer();
      const registry = createMcpProofPluginRegistry();
      const foreignProviderCalls: string[] = [];
      const registerProvider = () =>
        registry.apiFor("plugin-a").registerMcpServerRequestHeaderProvider({
          serverName: "user-mail",
          resolve: (context) => {
            foreignProviderCalls.push(context.runId ?? "unknown");
            return { "x-plugin-a": "attribution" };
          },
        });
      const registerResolver = () =>
        registry.apiFor("plugin-b").registerMcpServerConnectionResolver({
          serverName: "user-mail",
          resolve: (context) =>
            context.requesterSenderId === "allowed-requester"
              ? { url: proof.url, headers: { Authorization: "Bearer proof-token" } }
              : null,
        });
      if (order === "provider-first") {
        registerProvider();
        registerResolver();
      } else {
        registerResolver();
        registerProvider();
      }

      const singletonStore = globalThis as Record<PropertyKey, unknown>;
      const hadRuntimeManager = Object.hasOwn(singletonStore, SESSION_MCP_RUNTIME_MANAGER_KEY);
      const previousRuntimeManager = singletonStore[SESSION_MCP_RUNTIME_MANAGER_KEY];
      singletonStore[SESSION_MCP_RUNTIME_MANAGER_KEY] = createSessionMcpRuntimeManager();
      const cfg = { mcp: { servers: DECLARED_SERVERS } } as never;
      const paramsFor = (sessionId: string, requesterSenderId: string | undefined) => ({
        ...makeRequesterParams(sessionId, cfg, requesterSenderId ?? "", { requesterSenderId }),
        autoApproveCodexAppServerApprovals: true,
      });
      let allowedTools:
        | Awaited<ReturnType<typeof materializeRequesterScopedMcpToolsForHarnessRun>>
        | undefined;
      try {
        await withPluginRuntimeRegistryScope(registry.registry, async () => {
          // Never static: a static classification would expose the declared connection
          // to requesters the resolver excludes.
          const partition = partitionMcpServersByConnectionScope(DECLARED_SERVERS);
          expect(partition.staticServers).toEqual({});
          expect(partition.resolverRequesterServerNames).toEqual(["user-mail"]);
          // Registry state is identical in both orders: resolver present, foreign provider gone.
          expect(registry.registry.mcpServerConnectionResolvers).toMatchObject([
            { pluginId: "plugin-b", resolver: { serverName: "user-mail" } },
          ]);
          expect(registry.registry.mcpServerRequestHeaderProviders).toEqual([]);
          console.log(`[pr154043-order-proof] ${order}: user-mail partitioned as resolver-scoped`);

          allowedTools = expectDefined(
            await materializeRequesterScopedMcpToolsForHarnessRun(
              paramsFor("pr154043-allowed", "allowed-requester"),
            ),
            "allowed requester tools",
          );
          const probe = expectDefined(
            allowedTools.tools.find((tool) => tool.name.endsWith("requester_probe")),
            "requester_probe tool",
          );
          const result = await probe.execute("allowed-call", {});
          expect(result.content[0]).toMatchObject({ type: "text", text: proof.session.current });
          expect(proof.requests.length).toBeGreaterThan(0);
          expect(proof.requests.every((h) => h.authorization === "Bearer proof-token")).toBe(true);
          expect(proof.requests.every((h) => h["x-plugin-a"] === undefined)).toBe(true);
          const servedRequests = proof.requests.length;
          console.log(
            `[pr154043-order-proof] ${order}: allowed requester executed requester_probe; loopback served ${servedRequests} bearer-authorized requests`,
          );
          await allowedTools.dispose();
          allowedTools = undefined;

          expect(
            await materializeRequesterScopedMcpToolsForHarnessRun(
              paramsFor("pr154043-excluded", "excluded-requester"),
            ),
          ).toBeUndefined();
          expect(
            await materializeRequesterScopedMcpToolsForHarnessRun(
              paramsFor("pr154043-anonymous", undefined),
            ),
          ).toBeUndefined();
          expect(proof.requests).toHaveLength(servedRequests);
          expect(foreignProviderCalls).toEqual([]);
          console.log(
            `[pr154043-order-proof] ${order}: excluded + anonymous requesters got no tools; loopback request count unchanged (${servedRequests}); foreign provider never invoked`,
          );
        });
      } finally {
        await allowedTools?.dispose();
        await testing.resetSessionMcpRuntimeManager();
        if (hadRuntimeManager) {
          singletonStore[SESSION_MCP_RUNTIME_MANAGER_KEY] = previousRuntimeManager;
        } else {
          delete singletonStore[SESSION_MCP_RUNTIME_MANAGER_KEY];
        }
        await proof.close();
      }
    },
  );
});
