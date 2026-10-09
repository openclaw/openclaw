import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";

const attachment = { type: "image", mimeType: "image/png", content: "cGljdHVyZQ==" };
const uploads: Array<[string, Record<string, unknown>]> = [
  ...[
    "chat.send",
    "agent",
    "sessions.create",
    "sessions.send",
    "sessions.steer",
    "sessions.companion.ask",
  ].map((method): [string, Record<string, unknown>] => [method, { attachments: [attachment] }]),
  ["terminal.upload", { name: "report.txt", contentBase64: "aGVsbG8=" }],
  ["users.setAvatar", { avatarBase64: "cGljdHVyZQ==" }],
  ["agents.create", { avatar: "data:image/png;base64,cGljdHVyZQ==" }],
  ["agents.update", { avatar: " DATA:image/png;base64,cGljdHVyZQ==" }],
  ["skills.upload.begin", { kind: "skill-archive" }],
  ["skills.upload.chunk", { uploadId: "archive", data: "aGVsbG8=" }],
  ["skills.upload.commit", { uploadId: "archive" }],
  ["skills.install", { source: "upload", uploadId: "archive" }],
  ["skills.library.upload", { content: "aGVsbG8=" }],
  ["skills.library.save", { files: [{ path: "test.txt", content: "aGVsbG8=" }] }],
  ["send", { buffer: "aGVsbG8=" }],
  ["send", { mediaUrl: "data:image/png;base64,cGljdHVyZQ==" }],
  ["message.action", { params: { buffer: "aGVsbG8=" } }],
  ["message.action", { params: { mediaUrls: ["data:image/png;base64,cGljdHVyZQ=="] } }],
];

function setup(config: OpenClawConfig = {}, synthetic = false) {
  const client: GatewayClient = {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.admin"],
      client: { id: "test", mode: "test", platform: "test", version: "1" },
    },
    ...(synthetic ? { internal: { syntheticClient: true as const } } : {}),
  };
  let currentConfig = config;
  const getConfig = () => currentConfig;
  const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { accepted: true }));
  async function dispatch(
    method: string,
    params: Record<string, unknown>,
    implementation: GatewayRequestHandler = handler,
  ) {
    const requestParams = {
      ...(method === "chat.send" ? { sessionKey: "agent:main:upload-policy" } : {}),
      ...(["sessions.send", "sessions.steer"].includes(method)
        ? { key: "agent:main:upload-policy" }
        : {}),
      ...params,
    };
    const respond = vi.fn();
    // Exercise the real router; replace only the upload side effect.
    const methodRegistry = createGatewayMethodRegistry([
      {
        name: method,
        handler: implementation,
        scope: "operator.admin",
        owner: { kind: "core", area: "upload-test" },
        profileAccess: "independent",
      },
    ]);
    await handleGatewayRequest({
      req: { type: "req", id: "upload-test", method, params: requestParams },
      respond,
      client,
      isWebchatConnect: () => false,
      context: { getRuntimeConfig: getConfig, getCommittedRuntimeConfig: getConfig } as Parameters<
        typeof handleGatewayRequest
      >[0]["context"],
      methodRegistry,
    });
    return respond;
  }
  return {
    handler,
    dispatch,
    setConfig: (next: OpenClawConfig) => {
      currentConfig = next;
    },
  };
}

function expectDisabled(respond: ReturnType<typeof vi.fn>) {
  expect(respond).toHaveBeenCalledWith(false, undefined, {
    code: "FORBIDDEN",
    message: "File and image uploads are disabled by gateway.uploads.enabled",
    details: { code: "UPLOADS_DISABLED" },
  });
}

describe("Gateway upload admission", () => {
  it("hot-applies upload policy to client bytes without trusting wire exemptions", async () => {
    const test = setup();
    for (const enabled of [undefined, true, false, true]) {
      test.setConfig({ gateway: { uploads: { enabled } } });
      test.handler.mockClear();
      for (const [method, params] of [
        ...uploads,
        ["send", { buffer: "aGVsbG8=", internal: { syntheticClient: true } }],
      ] satisfies Array<[string, Record<string, unknown>]>) {
        const response = await test.dispatch(method, params);
        if (enabled === false) {
          expectDisabled(response);
          expect(test.handler).not.toHaveBeenCalled();
        } else {
          expect(response).toHaveBeenCalledWith(true, { accepted: true });
        }
      }
      expect(test.handler).toHaveBeenCalledTimes(enabled === false ? 0 : uploads.length + 1);
    }
  });
  it("preserves text edits, existing media and trusted generated media with uploads disabled", async () => {
    const cases: Array<[string, Record<string, unknown>, boolean?]> = [
      ["chat.send", { message: "plain text", attachments: [] }],
      ["sessions.create", { message: "plain text" }],
      ["sessions.send", { message: "plain text" }],
      ["sessions.files.get", { path: "existing.png" }],
      ["sessions.files.set", { path: "existing.txt", content: "edited", expectedHash: "hash" }],
      ["agents.update", { avatar: "https://example.test/existing.png" }],
      ["send", { mediaUrl: "/existing/output.png" }],
      ["skills.install", { source: "clawhub", slug: "example" }],
      ["skills.library.save", { markdown: "# Edited skill" }],
      ["themes.import", { id: "custom", definition: { name: "Custom", description: "Palette" } }],
      ["send", { buffer: "aGVsbG8=" }, true],
    ];
    for (const [method, params, synthetic] of cases) {
      const test = setup({ gateway: { uploads: { enabled: false } } }, synthetic);
      expect(await test.dispatch(method, params)).toHaveBeenCalledWith(true, { accepted: true });
    }
  });
  it("rejects an upload disabled while its lazy handler prepares", async () => {
    const test = setup();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const lazy = createLazyCoreHandlers({
      methods: ["terminal.upload"],
      loadHandlers: async () => {
        entered.resolve();
        await release.promise;
        return { "terminal.upload": test.handler };
      },
    });
    const pending = test.dispatch("terminal.upload", {}, lazy["terminal.upload"]);
    await entered.promise;
    test.setConfig({ gateway: { uploads: { enabled: false } } });
    release.resolve();
    expectDisabled(await pending);
    expect(test.handler).not.toHaveBeenCalled();
  });
});
