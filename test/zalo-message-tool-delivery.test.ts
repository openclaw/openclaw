import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { afterEach, expect, it, vi } from "vitest";
import { zaloPlugin } from "../extensions/zalo/api.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import { OutboundDeliveryError } from "../src/infra/outbound/deliver-types.js";
import { runMessageAction } from "../src/infra/outbound/message-action-runner.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { respondJson } from "./helpers/gateway-integration-fixtures.js";

const { resolvePhotoHost } = vi.hoisted(() => ({ resolvePhotoHost: vi.fn() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  resolvePinnedHostnameWithPolicy: resolvePhotoHost,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resolvePhotoHost.mockReset();
  setActivePluginRegistry(createTestRegistry([]));
});

function installConfig() {
  const cfg = { channels: { zalo: { enabled: true, botToken: "test-zalo-token" } } };
  setRuntimeConfigSnapshot(cfg);
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "zalo", source: "test", plugin: zaloPlugin }]),
  );
  return cfg;
}

function send(message: string, media: string, assertDirectAdapterHandoff: () => void) {
  return runMessageAction({
    cfg: installConfig(),
    action: "send",
    params: { channel: "zalo", to: "dm-chat", message, media },
    skipQueue: true,
    suppressTranscriptMirror: true,
    assertDirectAdapterHandoff,
  });
}

it.each([false, true])(
  "sends whitespace-media text and propagates API rejection (%s)",
  async (fail) => {
    await withOpenClawTestState({ prefix: "zalo-message-delivery-" }, async () => {
      const requests: Array<{ path: string | undefined; body: string }> = [];
      const assertDirectAdapterHandoff = vi.fn();
      const fixture = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((request, response) => {
            void text(request)
              .then((body) => {
                requests.push({ path: request.url, body });
                respondJson(
                  response,
                  fail
                    ? { ok: false, description: "fixture provider unavailable" }
                    : { ok: true, result: { message_id: "z-msg-with-blank-media" } },
                );
              })
              .catch((error: unknown) => {
                response.destroy(error instanceof Error ? error : new Error(String(error)));
              });
          }),
      });
      try {
        vi.stubEnv("ZALO_API_URL", `http://127.0.0.1:${fixture.claim.port}/zalo/`);
        const delivery = send("hello there", "   ", assertDirectAdapterHandoff);
        if (fail) {
          await expect(delivery).rejects.toThrow("fixture provider unavailable");
        } else {
          expect(await delivery).toMatchObject({
            handledBy: "core",
            payload: {
              result: {
                messageId: "z-msg-with-blank-media",
                receipt: { platformMessageIds: ["z-msg-with-blank-media"] },
              },
            },
          });
        }
        expect(requests).toEqual([
          {
            path: "/zalo/bottest-zalo-token/sendMessage",
            body: JSON.stringify({ chat_id: "dm-chat", text: "hello there" }),
          },
        ]);
        expect(assertDirectAdapterHandoff).toHaveBeenCalled();
      } finally {
        await fixture.releaseListener();
        await fixture.claim.release();
      }
    });
  },
);

it("rechecks message-action authority after awaiting photo preparation", async () => {
  await withOpenClawTestState({ prefix: "zalo-message-authority-" }, async () => {
    const started = Promise.withResolvers<void>();
    const prepared = Promise.withResolvers<void>();
    resolvePhotoHost.mockImplementationOnce(async () => {
      started.resolve();
      await prepared.promise;
      return { hostname: "example.com", addresses: ["93.184.216.34"], lookup: vi.fn() };
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    const authorityError = new Error("source authority revoked");
    let current = true;
    const delivery = send("caption", "https://example.com/photo.jpg", () => {
      if (!current) {
        throw authorityError;
      }
    });
    await started.promise;
    current = false;
    prepared.resolve();
    const failure = await delivery.catch((error: unknown) => error);
    if (!(failure instanceof OutboundDeliveryError)) {
      throw new Error("Expected failed outbound delivery");
    }
    expect(failure.sentBeforeError).toBe(false);
    expect(failure.cause).toBe(authorityError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
