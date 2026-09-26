import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const loopback = vi.hoisted(() => ({ baseUrl: "", editStatus: 200 }));
const requests = vi.hoisted(() => [] as Array<{ method: string; path: string; body: string }>);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    // Keep the real guarded fetch; only send it at the loopback origin.
    fetchWithSsrFGuard: async (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      const [params] = args;
      const url = new URL(params.url);
      if (
        url.origin !== "https://chat.googleapis.com" &&
        url.origin !== "https://oauth2.googleapis.com"
      ) {
        throw new Error(`Unexpected origin in Google Chat fixture: ${url.origin}`);
      }
      return await actual.fetchWithSsrFGuard({
        ...params,
        url: `${loopback.baseUrl}${url.pathname}${url.search}`,
        dispatcherPolicy: { mode: "direct" },
        policy: { allowPrivateNetwork: true },
      });
    },
  };
});

import { googlechatPlugin } from "../extensions/googlechat/api.js";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../src/gateway/message-action-turn-capability.js";

const CANONICAL_SPACE = "spaces/AAQA1bC2dEf";
const FOLDED_SPACE = "spaces/aaqa1bc2def";
const SESSION_KEY = `agent:main:googlechat:group:${FOLDED_SPACE}`;

let server: Server;

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      const path = request.url ?? "";
      if (path === "/token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "transport-proof-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
        return;
      }
      requests.push({
        method: request.method ?? "",
        path,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (request.method === "PATCH") {
        response.writeHead(loopback.editStatus, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            loopback.editStatus === 200
              ? { name: path.replace(/^\/v1\//, "").split("?")[0] }
              : { error: { message: "Edit denied by fixture" } },
          ),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (request.method === "POST" && path.includes("/messages")) {
        const space = path.replace(/^\/v1\//, "").replace(/\/messages.*$/, "");
        response.end(JSON.stringify({ name: `${space}/messages/proof-1` }));
        return;
      }
      response.end(JSON.stringify({ name: path.replace(/^\/v1\//, ""), spaceType: "SPACE" }));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  loopback.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  setActivePluginRegistry(createTestRegistry([]));
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe("session-derived Google Chat delivery", () => {
  it("sends and edits in the canonical mixed-case space recorded by the session", async () => {
    await withOpenClawTestState({ prefix: "googlechat-session-target-" }, async (state) => {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const config: OpenClawConfig = {
        agents: { entries: { main: { default: true, workspace: state.workspaceDir } } },
        channels: {
          googlechat: {
            accounts: {
              default: {
                serviceAccount: JSON.stringify({
                  type: "service_account",
                  client_email: "proof@example.iam.gserviceaccount.com",
                  private_key: privateKey,
                }),
              },
            },
          },
        },
      };

      // The session recorded its canonical destination on the inbound turn.
      await upsertSessionEntry({
        agentId: "main",
        env: process.env,
        sessionKey: SESSION_KEY,
        entry: {
          sessionId: "proof-session",
          updatedAt: Date.now(),
          delivery: {
            kind: "external",
            route: { channel: "googlechat", target: { to: `googlechat:${CANONICAL_SPACE}` } },
            context: { channel: "googlechat", to: `googlechat:${CANONICAL_SPACE}` },
            origin: { provider: "googlechat", to: `googlechat:${CANONICAL_SPACE}` },
          },
        },
      });

      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "googlechat", source: "test", origin: "bundled", plugin: googlechatPlugin },
        ]),
      );

      requests.length = 0;

      // The ambient surface is webchat; the destination exists only in the folded session
      // key and in the session's stored delivery metadata.
      const tools = createOpenClawCodingTools({
        config,
        agentId: "main",
        sessionKey: SESSION_KEY,
        sessionId: "proof-session",
        messageProvider: "webchat",
        workspaceDir: state.workspaceDir,
      });
      const tool = tools.find((entry) => entry.name === "message");
      expect(tool, "message tool present in the harness tool list").toBeDefined();

      // No explicit target: the tool must derive the destination from the session.
      const result = await tool!.execute("proof-1", {
        action: "send",
        message: "session-derived reply",
      });

      const sends = requests.filter((entry) => entry.method === "POST");
      expect(result.details).toMatchObject({ ok: true, to: CANONICAL_SPACE });
      expect(sends).toHaveLength(1);
      expect(sends[0]?.path).toBe(`/v1/${CANONICAL_SPACE}/messages`);
      expect(JSON.parse(sends[0]!.body)).toEqual({ text: "session-derived reply" });

      // Editing requires the host-admitted current conversation and account.
      const runId = "googlechat-edit-proof";
      const capability = mintMessageActionTurnCapability({
        agentId: "main",
        runId,
        sessionKey: SESSION_KEY,
        sessionId: "proof-session",
        requesterAccountId: "default",
        toolContext: {
          currentChannelProvider: "googlechat",
          currentChatType: "group",
          currentChannelId: CANONICAL_SPACE,
        },
      });
      try {
        const editTool = createOpenClawCodingTools({
          config,
          agentId: "main",
          agentAccountId: "default",
          runId,
          sessionKey: SESSION_KEY,
          sessionId: "proof-session",
          messageProvider: "googlechat",
          messageTo: CANONICAL_SPACE,
          currentChannelId: CANONICAL_SPACE,
          chatType: "group",
          messageActionTurnCapability: capability,
          workspaceDir: state.workspaceDir,
        }).find((entry) => entry.name === "message");
        expect(editTool).toBeDefined();
        // Use the ID returned by send through the registered tool and lazy adapter.
        const messageId = `${CANONICAL_SPACE}/messages/proof-1`;
        const edit = (id = messageId) =>
          editTool!.execute("edit-proof", {
            action: "edit",
            target: CANONICAL_SPACE,
            messageId: id,
            message: "corrected reply",
          });
        requests.length = 0;
        const edited = await edit();
        expect(edited.details).toMatchObject({
          ok: true,
          to: CANONICAL_SPACE,
          messageName: messageId,
        });
        expect(requests.filter((entry) => entry.method !== "GET")).toEqual([
          {
            method: "PATCH",
            path: `/v1/${messageId}?updateMask=text`,
            body: JSON.stringify({ text: "corrected reply" }),
          },
        ]);

        requests.length = 0;
        await expect(edit(`${FOLDED_SPACE}/messages/proof-1`)).rejects.toThrow(
          "messageId must belong to the target Google Chat space",
        );
        expect(requests.filter((entry) => entry.method !== "GET")).toEqual([]);

        for (const status of [403, 404]) {
          requests.length = 0;
          loopback.editStatus = status;
          await expect(edit()).rejects.toThrow(`Google Chat API ${status}`);
          expect(
            requests.filter((entry) => entry.method !== "GET").map((entry) => entry.method),
          ).toEqual(["PATCH"]);
        }
      } finally {
        loopback.editStatus = 200;
        revokeMessageActionTurnCapability(capability);
      }
    });
  }, 60_000);
});
