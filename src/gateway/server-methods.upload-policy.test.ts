import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient } from "./server-methods/client-types.js";
import { createLazyCoreHandlers } from "./server-methods/lazy-core-handlers.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { captureGatewayClientUploadCommitGuard } from "./upload-policy.js";

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
  it("retains client byte classification after hydration replaces its buffer", () => {
    let enabled = true;
    const requestParams: Record<string, unknown> = { buffer: "cHJvb2Y=" };
    const getConfig = () => ({ gateway: { uploads: { enabled } } });
    const assertCurrent = captureGatewayClientUploadCommitGuard({
      method: "send",
      requestParams,
      client: null,
      context: { getRuntimeConfig: getConfig, getCommittedRuntimeConfig: getConfig },
    });
    expect(assertCurrent).toBeTypeOf("function");
    assertCurrent?.();
    delete requestParams.buffer;
    requestParams.media = "/stored/proof.txt";
    enabled = false;
    expect(() => assertCurrent?.()).toThrow("uploads are disabled");
  });

  it.each(uploads)("rejects %s before its upload handler runs", async (method, params) => {
    const test = setup({ gateway: { uploads: { enabled: false } } });
    expectDisabled(await test.dispatch(method, params));
    expect(test.handler).not.toHaveBeenCalled();
  });
  it.each([undefined, true])("preserves upload dispatch with enabled=%s", async (enabled) => {
    const test = setup({ gateway: { uploads: { enabled } } });
    for (const [method, params] of uploads) {
      expect(await test.dispatch(method, params)).toHaveBeenCalledWith(true, { accepted: true });
    }
    expect(test.handler).toHaveBeenCalledTimes(uploads.length);
  });
  it.each([
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
  ] satisfies Array<[string, Record<string, unknown>]>)(
    "preserves non-upload %s",
    async (method, params) => {
      const test = setup({ gateway: { uploads: { enabled: false } } });
      expect(await test.dispatch(method, params)).toHaveBeenCalledWith(true, { accepted: true });
    },
  );
  it("preserves trusted internal generated-media delivery", async () => {
    const test = setup({ gateway: { uploads: { enabled: false } } }, true);
    expect(await test.dispatch("send", { buffer: "aGVsbG8=" })).toHaveBeenCalledWith(true, {
      accepted: true,
    });
  });
  it("does not trust a wire payload claiming to be internal", async () => {
    const test = setup({ gateway: { uploads: { enabled: false } } });
    expectDisabled(
      await test.dispatch("send", { buffer: "aGVsbG8=", internal: { syntheticClient: true } }),
    );
    expect(test.handler).not.toHaveBeenCalled();
  });
  it("hot-applies disabling and re-enabling on an existing context", async () => {
    const test = setup();
    expect(await test.dispatch("terminal.upload", {})).toHaveBeenCalledWith(true, {
      accepted: true,
    });
    test.setConfig({ gateway: { uploads: { enabled: false } } });
    expectDisabled(await test.dispatch("terminal.upload", {}));
    test.setConfig({ gateway: { uploads: { enabled: true } } });
    expect(await test.dispatch("terminal.upload", {})).toHaveBeenCalledWith(true, {
      accepted: true,
    });
    expect(test.handler).toHaveBeenCalledTimes(2);
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
