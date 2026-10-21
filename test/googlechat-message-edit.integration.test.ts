import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenClawCodingTools } from "openclaw/plugin-sdk/agent-harness";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const loopback = vi.hoisted(() => ({ baseUrl: "", editStatus: 200 }));
const requests = vi.hoisted(() => [] as Array<{ method: string; path: string; body: string }>);
const heldResponse = vi.hoisted(() => ({
  path: "",
  resolve: undefined as ((response: ServerResponse) => void) | undefined,
  response: undefined as ServerResponse | undefined,
}));

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
let existingMessage = {
  name: `${CANONICAL_SPACE}/messages/proof-1`,
  text: "original text",
  cardsV2: [{ cardId: "preserved-card", card: { header: { title: "Existing card" } } }],
  attachment: [{ name: "media/existing", contentName: "existing.txt" }],
};

afterEach(() => {
  if (heldResponse.response && !heldResponse.response.writableEnded) {
    heldResponse.response.destroy();
  }
  heldResponse.path = "";
  heldResponse.resolve = undefined;
  heldResponse.response = undefined;
  clearRuntimeConfigSnapshot();
});

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    request.on("end", () => {
      const path = request.url ?? "";
      if (path === heldResponse.path && heldResponse.resolve) {
        const resolve = heldResponse.resolve;
        heldResponse.resolve = undefined;
        heldResponse.response = response;
        resolve(response);
        return;
      }
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
        if (loopback.editStatus === 200 && path === `/v1/${existingMessage.name}?updateMask=text`) {
          existingMessage = {
            ...existingMessage,
            text: (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text: string }).text,
          };
        }
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
      if (request.method === "GET" && path === `/v1/${existingMessage.name}`) {
        response.end(JSON.stringify(existingMessage));
        return;
      }
      if (path.startsWith("/v1/spaces:findDirectMessage?")) {
        response.end(JSON.stringify({ name: CANONICAL_SPACE, spaceType: "DIRECT_MESSAGE" }));
        return;
      }
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
    server.closeAllConnections();
  });
});

async function withAdmittedEdit(
  label: string,
  currentTarget: string,
  run: (fixture: {
    edit: (params?: {
      target?: string;
      messageId?: string;
      accountId?: string;
    }) => Promise<unknown>;
    revoke: () => void;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ prefix: `googlechat-edit-${label}-` }, async (state) => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const serviceAccount = (accountId: string) =>
      JSON.stringify({
        type: "service_account",
        client_email: `${label}-${accountId}@example.iam.gserviceaccount.com`,
        private_key: privateKey,
      });
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      tools: { message: { crossContext: { allowWithinProvider: true } } },
      channels: {
        googlechat: {
          accounts: {
            default: { serviceAccount: serviceAccount("default") },
            work: { serviceAccount: serviceAccount("work") },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    setActivePluginRegistry(
      createTestRegistry([
        { pluginId: "googlechat", source: "test", origin: "bundled", plugin: googlechatPlugin },
      ]),
    );
    const runId = `googlechat-edit-${label}`;
    const sessionKey = `agent:main:googlechat:${currentTarget}`;
    const chatType = currentTarget.startsWith("users/") ? "direct" : "group";
    const capability = mintMessageActionTurnCapability({
      agentId: "main",
      runId,
      sessionKey,
      sessionId: "proof-session",
      requesterAccountId: "default",
      toolContext: {
        currentChannelProvider: "googlechat",
        currentChatType: chatType,
        currentChannelId: currentTarget,
      },
    });
    try {
      const tool = createOpenClawCodingTools({
        config,
        agentId: "main",
        agentAccountId: "default",
        runId,
        sessionKey,
        sessionId: "proof-session",
        messageProvider: "googlechat",
        messageTo: currentTarget,
        currentChannelId: currentTarget,
        chatType,
        messageActionTurnCapability: capability,
        workspaceDir: state.workspaceDir,
      }).find((entry) => entry.name === "message");
      expect(tool).toBeDefined();
      requests.length = 0;
      await run({
        edit: (params = {}) =>
          tool!.execute("edit-authority-proof", {
            action: "edit",
            target: currentTarget,
            messageId: `${CANONICAL_SPACE}/messages/proof-1`,
            message: "corrected reply",
            ...params,
          }),
        revoke: () => revokeMessageActionTurnCapability(capability),
      });
    } finally {
      revokeMessageActionTurnCapability(capability);
    }
  });
}

describe("session-derived Google Chat delivery", () => {
  it("sends and edits in the canonical mixed-case space recorded by the session", async () => {
    await withOpenClawTestState({ prefix: "googlechat-session-target-" }, async (state) => {
      const { privateKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const config: OpenClawConfig = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
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
      setRuntimeConfigSnapshot(config);

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

  it("edits the admitted existing message without replacing its non-text content", async () => {
    existingMessage.text = "original text";
    const before = structuredClone(existingMessage);
    await withAdmittedEdit("preserve-content", CANONICAL_SPACE, async ({ edit }) => {
      await edit();
      expect(requests.filter((entry) => entry.method !== "GET")).toEqual([
        {
          method: "PATCH",
          path: `/v1/${before.name}?updateMask=text`,
          body: JSON.stringify({ text: "corrected reply" }),
        },
      ]);
      const readback = await fetch(`${loopback.baseUrl}/v1/${before.name}`);
      expect(await readback.json()).toEqual({ ...before, text: "corrected reply" });
    });
  });

  it("denies other-account through the host before provider mutation", async () => {
    await withAdmittedEdit("other-account", CANONICAL_SPACE, async ({ edit }) => {
      await expect(edit({ accountId: "work" })).rejects.toThrow(
        "Explicit account does not match the trusted current account.",
      );
      expect(requests.filter((entry) => entry.method === "PATCH")).toEqual([]);
    });
  });

  it.each([
    {
      label: "other-conversation",
      params: { target: "spaces/OTHER", messageId: "spaces/OTHER/messages/proof-1" },
    },
  ])("denies $label through the host before provider mutation", async ({ label, params }) => {
    await withAdmittedEdit(label, CANONICAL_SPACE, async ({ edit }) => {
      await expect(edit(params)).rejects.toThrow("exact current conversation and account");
      expect(requests.filter((entry) => entry.method === "PATCH")).toEqual([]);
    });
  });

  it.each(["token", "lookup"] as const)(
    "revoking the host turn during real %s preparation prevents PATCH",
    async (phase) => {
      const currentTarget = phase === "lookup" ? "users/123" : CANONICAL_SPACE;
      await withAdmittedEdit(`revoke-${phase}`, currentTarget, async ({ edit, revoke }) => {
        const arrived = createDeferred<ServerResponse>();
        heldResponse.path =
          phase === "token" ? "/token" : "/v1/spaces:findDirectMessage?name=users%2F123";
        heldResponse.resolve = arrived.resolve;
        const editing = edit().then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        const response = await Promise.race([
          arrived.promise,
          editing.then(() => {
            throw new Error(`Edit settled before the ${phase} preparation barrier`);
          }),
        ]);
        revoke();
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(
            phase === "token"
              ? { access_token: "transport-proof-token", token_type: "Bearer", expires_in: 3600 }
              : { name: CANONICAL_SPACE, spaceType: "DIRECT_MESSAGE" },
          ),
        );
        const outcome = await editing;
        expect(requests.filter((entry) => entry.method === "PATCH")).toEqual([]);
        expect(outcome).toMatchObject({
          error: { message: "message action turn capability is no longer active" },
        });
      });
    },
  );
});
