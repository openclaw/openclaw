import { once } from "node:events";
import { buildControlUiPublicSessionSharePath } from "@openclaw/session-url-contract/public-share";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as publicAttachments from "./control-ui-public-session-attachments.js";
import { publicReadBarrier } from "./control-ui-public-session-barrier.test-support.js";
import { loadPublicSessionShareTokenCodec } from "./control-ui-public-session-token.js";
import { AUTH_TOKEN, createTestGatewayServer } from "./server-http.test-harness.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

it("serves public text and images through real publication, isolation, and revocation owners", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const locator = {
      agentId: "main",
      sessionKey: "agent:main:dashboard:bbbbbbbb-aaaa-4000-8000-000000000001",
      sessionId: "public-instance",
      shareId: "a".repeat(48),
    };
    async function publish(
      target: typeof locator,
      messages: { id: string; message: object }[],
      label?: string,
    ) {
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
        label,
        publicShare: { id: target.shareId, sessionId: target.sessionId, createdAt: 1 },
      });
      await replaceTranscriptEvents(target, [
        { type: "session", version: 3, id: target.sessionId },
        ...messages.map((entry, index) => ({
          type: "message",
          ...entry,
          parentId: messages[index - 1]?.id ?? null,
        })),
      ]);
    }
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5r8AAAAASUVORK5CYII=",
      "base64",
    );
    const other = {
      ...locator,
      sessionKey: "agent:main:other-publication",
      sessionId: "other-public-instance",
      shareId: "b".repeat(48),
    };
    const imageMessage = {
      role: "assistant",
      content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }],
    };
    await publish(other, [{ id: "other-image", message: imageMessage }]);
    await publish(
      locator,
      [
        { id: "question", message: { role: "user", content: "Public question" } },
        { id: "answer", message: { role: "assistant", content: "Public answer" } },
        { id: "image", message: imageMessage },
        { id: "held-image", message: imageMessage },
      ],
      "Public concurrency",
    );
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
        httpRequestLifetime: context,
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
      const codec = await loadPublicSessionShareTokenCodec();
      const token = codec.mint(locator);
      const otherToken = codec.mint(other);
      const path = buildControlUiPublicSessionSharePath({ token });
      const origin = `http://127.0.0.1:${address.port}`;
      const mediaUrl = (shareToken: string, entry: string) =>
        `${origin}/share/session/media?${new URLSearchParams({ token: shareToken, entry, attachment: "content-0" })}`;
      const paths = [path, "/chat/main/public-concurrency-bbbbbbbbaaaa40008000000000000001"];
      const validators = new Map<string, string>();
      for (const publicPath of paths) {
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
        expect(replies.every((reply) => reply.body.includes("/share/session/media?token="))).toBe(
          true,
        );
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
      }
      const image = await fetch(mediaUrl(token, "image"));
      expect(image.status).toBe(200);
      expect(Buffer.from(await image.arrayBuffer())).toEqual(png);
      expect(image.headers.get("content-type")).toBe("image/png");
      expect(image.headers.get("content-disposition")).toBe("inline");
      expect(image.headers.get("x-content-type-options")).toBe("nosniff");
      const imageEtag = image.headers.get("etag");
      if (!imageEtag) {
        throw new Error("Public image omitted its validator");
      }
      expect(
        (await fetch(mediaUrl(token, "image"), { headers: { "If-None-Match": imageEtag } })).status,
      ).toBe(304);
      const otherImage = await fetch(mediaUrl(otherToken, "other-image"));
      expect(otherImage.status).toBe(200);
      expect(Buffer.from(await otherImage.arrayBuffer())).toEqual(png);
      const crossPublication = await fetch(mediaUrl(token, "other-image"));
      const unknownEntry = await fetch(mediaUrl(token, "missing-image"));
      expect(crossPublication.status).toBe(404);
      expect(await crossPublication.text()).toBe(await unknownEntry.text());

      const barrier = publicReadBarrier(signal);
      const readAttachment = publicAttachments.readPublicSessionAttachment;
      const heldRead = vi
        .spyOn(publicAttachments, "readPublicSessionAttachment")
        .mockImplementationOnce(async (...args) => {
          const bytes = await readAttachment(...args);
          await barrier.hold();
          return bytes;
        });
      const pending = fetch(mediaUrl(token, "held-image"));
      try {
        await barrier.wait(pending, "Media request settled before reading the attachment");
        await patchSessionEntryCore(locator, () => ({ publicShare: undefined }));
      } finally {
        barrier.release();
        heldRead.mockRestore();
      }
      const deniedInFlight = await pending;
      expect([404, 503]).toContain(deniedInFlight.status);
      expect(deniedInFlight.headers.get("content-type")).toContain("text/plain");
      expect(Buffer.from(await deniedInFlight.arrayBuffer()).equals(png)).toBe(false);
      const revokedImage = await fetch(mediaUrl(token, "image"), {
        headers: { "If-None-Match": imageEtag },
      });
      expect(revokedImage.status).toBe(404);
      expect(await revokedImage.text()).toBe("This public session is unavailable.");
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
