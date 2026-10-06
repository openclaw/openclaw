import { once } from "node:events";
import { buildControlUiPublicSessionSharePath } from "@openclaw/session-url-contract/public-share";
import { expect, it } from "vitest";
import {
  patchSessionEntryCore,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadPublicSessionShareTokenCodec } from "./control-ui-public-session-token.js";
import { AUTH_TOKEN, createTestGatewayServer } from "./server-http.test-harness.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

it("serves twenty concurrent HTTP readers through real publication, history, and revocation owners", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const locator = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:bbbbbbbb-aaaa-4000-8000-000000000001",
      sessionId: "public-instance",
      shareId: "a".repeat(48),
    };
    await upsertSessionEntryCore(locator, {
      sessionId: locator.sessionId,
      updatedAt: 1,
      label: "Public concurrency",
      publicShare: { id: locator.shareId, sessionId: locator.sessionId, createdAt: 1 },
    });
    await replaceTranscriptEvents(locator, [
      { type: "session", version: 3, id: locator.sessionId },
      {
        type: "message",
        id: "question",
        parentId: null,
        message: { role: "user", content: "Public question" },
      },
      {
        type: "message",
        id: "answer",
        parentId: "question",
        message: { role: "assistant", content: "Public answer" },
      },
    ]);
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const context = createGatewayRequestContext(makeContextParams());
    context.resolveGatewayContext = () => context;
    bindSessionRowProjection(context, () => projection);
    const server = createTestGatewayServer({
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        getRuntimeConfig: () => cfg,
        getGatewayRequestContext: () => context,
      },
    });
    try {
      await projection.ensureMaterialized();
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP fixture has no address");
      }
      const path = buildControlUiPublicSessionSharePath({
        token: loadPublicSessionShareTokenCodec().mint(locator),
      });
      const origin = `http://127.0.0.1:${address.port}`;
      const paths = [path, "/chat/main/public-concurrency-bbbbbbbbaaaa40008000000000000001"];
      const validators = new Map<string, string>();
      for (const publicPath of paths) {
        const started = performance.now();
        const replies = await Promise.all(
          Array.from({ length: 20 }, async () => {
            const response = await fetch(`${origin}${publicPath}`);
            return {
              status: response.status,
              etag: response.headers.get("etag"),
              body: await response.text(),
            };
          }),
        );
        expect(replies.map((reply) => reply.status)).toEqual(Array(20).fill(200));
        expect(replies.every((reply) => reply.body.includes("Public answer"))).toBe(true);
        expect(new Set(replies.map((reply) => reply.etag)).size).toBe(1);
        const etag = replies[0]?.etag;
        if (!etag) {
          throw new Error("Public response omitted its validator");
        }
        validators.set(publicPath, etag);
        const unchanged = await fetch(`${origin}${publicPath}`, {
          headers: { "If-None-Match": etag },
        });
        expect(unchanged.status).toBe(304);
        await unchanged.arrayBuffer();
        console.info("public-reader proof", {
          route: publicPath === path ? "legacy" : "canonical",
          readers: 20,
          elapsedMs: Math.round(performance.now() - started),
        });
      }
      await patchSessionEntryCore(locator, () => ({ publicShare: undefined }));
      for (const [publicPath, etag] of validators) {
        const revoked = await fetch(`${origin}${publicPath}`, {
          headers: { "If-None-Match": etag },
        });
        expect(revoked.status).toBe(404);
        expect(await revoked.text()).not.toContain("Public answer");
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      projection.dispose();
    }
  });
});
