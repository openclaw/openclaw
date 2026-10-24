import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zaloPlugin } from "../extensions/zalo/api.js";
import { setRuntimeConfigSnapshot } from "../src/config/runtime-snapshot.js";
import { OutboundDeliveryError } from "../src/infra/outbound/deliver-types.js";
import { runMessageAction } from "../src/infra/outbound/message-action-runner.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createTestRegistry } from "../src/test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";

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

describe("Zalo core message delivery", () => {
  it.each([false, true])(
    "sends whitespace-media text and propagates API rejection (%s)",
    async (fail) => {
      await withOpenClawTestState({ prefix: "zalo-message-delivery-" }, async () => {
        const requests: Array<{ path: string | undefined; body: string }> = [];
        const fixture = await reserveTestPortListener({
          offsets: [0],
          createListener: () =>
            createServer((request, response) => {
              let body = "";
              request.setEncoding("utf8");
              request.on("data", (chunk: string) => {
                body += chunk;
              });
              request.on("end", () => {
                requests.push({ path: request.url, body });
                response.writeHead(200, { "content-type": "application/json" });
                response.end(
                  JSON.stringify(
                    fail
                      ? { ok: false, description: "fixture provider unavailable" }
                      : { ok: true, result: { message_id: "z-msg-with-blank-media" } },
                  ),
                );
              });
            }),
        });
        vi.stubEnv("ZALO_API_URL", `http://127.0.0.1:${fixture.claim.port}/zalo/`);
        const assertDirectAdapterHandoff = vi.fn();
        try {
          const delivery = runMessageAction({
            cfg: installConfig(),
            action: "send",
            params: {
              channel: "zalo",
              to: "dm-chat-blank-media",
              message: "hello there",
              media: "   ",
            },
            skipQueue: true,
            suppressTranscriptMirror: true,
            assertDirectAdapterHandoff,
          });
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
              body: JSON.stringify({ chat_id: "dm-chat-blank-media", text: "hello there" }),
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
      const delivery = runMessageAction({
        cfg: installConfig(),
        action: "send",
        params: {
          channel: "zalo",
          to: "dm-chat-photo",
          message: "caption",
          media: "https://example.com/photo.jpg",
        },
        skipQueue: true,
        suppressTranscriptMirror: true,
        assertDirectAdapterHandoff: () => {
          if (!current) {
            throw authorityError;
          }
        },
      });
      await started.promise;
      current = false;
      prepared.resolve();
      const failure = await delivery.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(OutboundDeliveryError);
      if (!(failure instanceof OutboundDeliveryError)) {
        throw new Error("Expected failed outbound delivery");
      }
      expect(failure.sentBeforeError).toBe(false);
      expect(failure.cause).toBe(authorityError);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
