import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discordPlugin } from "../extensions/discord/api.js";
import { slackPlugin } from "../extensions/slack/api.js";
import { dispatchChannelMessageAction } from "../src/channels/plugins/message-action-dispatch.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";

const guild = "100000000000000001";
const parent = "100000000000000002";
const current = "100000000000000003";
const sibling = "100000000000000004";
const slackTarget = "C0123456789";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetPluginRuntimeStateForTest();
});

// Registrar trust is a fixture here; installer/loader provenance has separate coverage.
// Responses and the terminal request log come from a real loopback HTTP server.
describe.each(["discord", "slack"] as const)("official %s provider read boundary", (channel) => {
  it.each(["allowed", "denied", "account", "revoked", "result-revoked", "legacy"] as const)(
    "routes a cross-conversation read through the provider (%s)",
    async (mode) => {
      const owner = createPluginRegistry({
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        runtime: {} as PluginRuntime,
        activateGlobalSideEffects: false,
      });
      const record = createPluginRecord({
        id: channel,
        origin: "global",
        trustedOfficialInstall: true,
      });
      const provider = channel === "discord" ? discordPlugin : slackPlugin;
      const plugin = {
        ...provider,
        // Status probes have provider-specific generics and are not part of message dispatch.
        status: undefined,
        actions: {
          ...provider.actions!,
          supportsReadAuthority: mode === "legacy" ? undefined : (true as const),
        },
      };
      owner.registry.plugins.push(record);
      owner.createApi(record, { config: {}, registrationMode: "full" }).registerChannel({ plugin });
      setActivePluginRegistry(owner.registry);
      const requests: string[] = [];
      const isContent = (url: string) =>
        url.includes("/messages") || url.includes("conversations.history");
      const server = createServer((request, response) => {
        const url = request.url!;
        requests.push(url);
        request.resume();
        let body: unknown;
        if (isContent(url)) {
          if (mode === "result-revoked") {
            record.enabled = false;
          }
          body = channel === "discord" ? [] : { ok: true, messages: [], has_more: false };
        } else {
          if (mode === "revoked") {
            record.enabled = false;
          }
          if (channel === "slack" && url.startsWith("/api/conversations.info")) {
            body = {
              ok: true,
              channel: {
                id: slackTarget,
                name: mode === "denied" ? "forbidden" : "allowed",
                is_channel: true,
              },
            };
          } else if (url.endsWith(`/channels/${sibling}`)) {
            body = { id: sibling, type: 11, parent_id: parent, guild_id: guild, name: "sibling" };
          } else if (url.endsWith(`/channels/${parent}`)) {
            body = { id: parent, type: 0, guild_id: guild, name: "discussion" };
          } else {
            response.writeHead(404);
            response.end();
            return;
          }
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected loopback TCP address");
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const realFetch = globalThis.fetch.bind(globalThis);
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        // No synthetic credential can escape to a real provider.
        if (channel === "discord") {
          expect(url.origin).toBe("https://discord.com");
          expect(url.pathname).toMatch(/^\/api\/v10\//);
          return realFetch(new URL(`${url.pathname}${url.search}`, baseUrl), init);
        }
        expect(url.origin).toBe(baseUrl);
        return realFetch(input, init);
      });
      vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
      for (const key of [
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "https_proxy",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
      ]) {
        vi.stubEnv(key, undefined);
      }
      try {
        const invocation = dispatchChannelMessageAction({
          cfg: {
            channels: {
              discord: {
                enabled: true,
                token: "synthetic-provider-fixture",
                groupPolicy: "allowlist",
                guilds: { [guild]: { channels: { [parent]: { enabled: mode !== "denied" } } } },
              },
              slack: {
                enabled: true,
                botToken: "synthetic-provider-fixture",
                groupPolicy: "allowlist",
                dangerouslyAllowNameMatching: true,
                channels: { "#allowed": { enabled: true } },
              },
            },
          },
          channel,
          action: "read",
          params: { channelId: channel === "discord" ? sibling : slackTarget, limit: 1 },
          accountId: "default",
          requesterAccountId: mode === "account" ? "other" : "default",
          conversationReadOrigin: "delegated",
          toolContext: {
            currentChannelProvider: channel,
            currentChannelId: channel === "discord" ? current : "C9876543210",
          },
        });
        if (mode === "allowed") {
          expect(await invocation).not.toBeNull();
          expect(requests.filter(isContent)).toHaveLength(1);
        } else {
          await expect(invocation).rejects.toThrow(
            mode === "legacy"
              ? "exact current conversation"
              : mode === "account"
                ? "current provider and account"
                : mode === "denied"
                  ? "not allowed"
                  : "no longer active",
          );
          expect(requests.filter(isContent)).toHaveLength(mode === "result-revoked" ? 1 : 0);
          if (mode === "legacy" || mode === "account") {
            expect(requests).toEqual([]);
          }
          if (mode === "revoked") {
            expect(requests).toHaveLength(1);
          }
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});
