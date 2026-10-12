import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import {
  buildControlUiPublicSessionCardPath,
  buildControlUiPublicSessionSharePath,
} from "@openclaw/session-url-contract/public-share";
import { expect, it, vi, type MockInstance } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import {
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { loadPublicSessionShareTokenCodec } from "./control-ui-public-session-token.js";
import { AUTH_TOKEN, createTestGatewayServer } from "./server-http.test-harness.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

const renderer = vi.hoisted(() => ({
  calls: 0,
  beforeReturn: undefined as (() => Promise<void>) | undefined,
}));

// Only the rendering boundary is paused; publication, history, and tokens stay real.
vi.mock(import("./control-ui-public-session-card.js"), async (importOriginal) => {
  const { renderPublicSessionCardPng } = await import("./control-ui-public-session-card-render.js");
  return {
    ...(await importOriginal()),
    createPublicSessionCardRenderer: () => ({
      async render(card: Parameters<typeof renderPublicSessionCardPng>[0]) {
        const png = renderPublicSessionCardPng(card);
        renderer.calls++;
        await renderer.beforeReturn?.();
        return png;
      },
      async dispose() {},
    }),
  };
});

// An independent, valid 1x1 PNG distinguishes the static fallback from rendered cards.
const FALLBACK = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1sAAAAASUVORK5CYII=",
  "base64",
);

it("serves real publication documents and PNGs once, and withholds closed publications", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const targets = {
      published: { name: "published", shareId: "a".repeat(48) },
      private: { name: "private", shareId: "b".repeat(48) },
      unpublished: { name: "unpublished", shareId: "c".repeat(48) },
      replaced: { name: "replaced", shareId: "d".repeat(48) },
      pending: { name: "pending", shareId: "e".repeat(48) },
    };
    const codec = await loadPublicSessionShareTokenCodec();
    const publications = await Promise.all(
      Object.values(targets).map(async ({ name, shareId }) => {
        const locator = {
          agentId: "main",
          sessionKey: `agent:main:public-card-${name}`,
          sessionId: `public-card-${name}-generation`,
          shareId,
        };
        await upsertSessionEntryCore(locator, {
          sessionId: locator.sessionId,
          updatedAt: 1,
          label: "Synthetic public card",
          ...(name === "private" ? { incognito: true } : {}),
          ...(name === "unpublished"
            ? {}
            : { publicShare: { id: shareId, sessionId: locator.sessionId, createdAt: 1 } }),
        });
        await replaceTranscriptEvents(locator, [
          { type: "session", version: 3, id: locator.sessionId },
          {
            type: "message",
            id: "question",
            parentId: null,
            message: { role: "user", content: "Show the synthetic public card." },
          },
          {
            type: "message",
            id: "answer",
            parentId: "question",
            message: { role: "assistant", content: "The published response is visible." },
          },
        ]);
        const token = codec.mint(locator);
        return {
          name,
          locator,
          documentPath: buildControlUiPublicSessionSharePath({ token, basePath: "/control" }),
          cardPath: buildControlUiPublicSessionCardPath({ token, basePath: "/control" }),
        };
      }),
    );
    const publication = (name: keyof typeof targets) => {
      const found = publications.find((entry) => entry.name === name);
      if (!found) {
        throw new Error(`Missing synthetic publication: ${name}`);
      }
      return found;
    };
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const context = createGatewayRequestContext(makeContextParams());
    context.resolveGatewayContext = () => context;
    bindSessionRowProjection(context, () => projection);
    const root = path.join(state.root, "control-ui");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "social-card.png"), FALLBACK);
    const server = createTestGatewayServer({
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "/control",
        controlUiRoot: { kind: "resolved", path: root },
        getRuntimeConfig: () => cfg,
        getGatewayRequestContext: () => context,
        httpRequestLifetime: context,
      },
    });
    const responseEnds: Array<MockInstance<ServerResponse["end"]>> = [];
    server.on("request", (_request, response) => {
      responseEnds.push(vi.spyOn(response, "end"));
    });
    const listener = await reserveTestPortListener({
      offsets: [0],
      signal,
      createListener: () => server,
    });
    const origin = `http://127.0.0.1:${listener.claim.port}`;
    const request = (route: string, headers?: Record<string, string>) =>
      fetch(`${origin}${route}`, { headers, signal });
    const expectFallback = async (response: Response) => {
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(FALLBACK);
    };
    renderer.calls = 0;
    try {
      await projection.ensureMaterialized();
      const published = publication("published");
      const document = await request(published.documentPath);
      expect(document.status).toBe(200);
      const html = await document.text();
      expect(html).toContain("The published response is visible.");
      expect(html).toContain("/control/share/session/card.png?token=");
      const etag = document.headers.get("etag");
      if (!etag) {
        throw new Error("Published document did not supply its validator");
      }
      const unchanged = await request(published.documentPath, { "If-None-Match": etag });
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe("");
      const card = await request(published.cardPath);
      expect(card.status).toBe(200);
      expect(card.headers.get("content-type")).toBe("image/png");
      expect(card.headers.get("cache-control")).toBe("public, max-age=300");
      const png = Buffer.from(await card.arrayBuffer());
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
      expect(png).not.toEqual(FALLBACK);
      const cached = await request(published.cardPath);
      expect(Buffer.from(await cached.arrayBuffer())).toEqual(png);
      expect(renderer.calls).toBe(1);

      for (const name of ["private", "unpublished"] as const) {
        await expectFallback(await request(publication(name).cardPath));
      }
      await patchSessionEntryCore(publication("replaced").locator, () => ({
        sessionId: "replacement-generation",
      }));
      await expectFallback(await request(publication("replaced").cardPath));
      await patchSessionEntryCore(published.locator, () => ({ publicShare: undefined }));
      await expectFallback(await request(published.cardPath));
      const revoked = await request(published.documentPath, { "If-None-Match": etag });
      expect(revoked.status).toBe(404);
      expect(await revoked.text()).toBe("This public session is unavailable.");
      expect(renderer.calls).toBe(1);

      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      renderer.beforeReturn = async () => {
        entered.resolve();
        await withinTest(release.promise, signal);
      };
      const pending = publication("pending");
      const rendering = request(pending.cardPath);
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            rendering,
            "Public card returned before reaching the renderer",
          ),
          signal,
        );
        await patchSessionEntryCore(pending.locator, () => ({ publicShare: undefined }));
      } finally {
        release.resolve();
      }
      await expectFallback(await rendering);
      expect(renderer.calls).toBe(2);
      expect(responseEnds).toHaveLength(10);
      for (const end of responseEnds) {
        expect(end).toHaveBeenCalledTimes(1);
      }
      console.info(
        "public-card HTTP proof: document=200/304 PNG=1200x630 cached-render=1 " +
          "private/unpublished/replaced/revoked/pending-revoked=exact-static-fallback responses=10 single-end",
      );
    } finally {
      renderer.beforeReturn = undefined;
      server.closeAllConnections();
      await listener.releaseListener();
      await listener.claim.release();
      projection.dispose();
      vi.restoreAllMocks();
    }
  });
});
