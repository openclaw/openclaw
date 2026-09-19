// Control UI assistant media e2e tests verify scoped media-ticket access through gateway HTTP routes.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import {
  recordInboundMediaOwner,
  recordStagedInboundMedia,
} from "../media/inbound-media-ownership.js";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const CONTROL_UI_E2E_TOKEN = "test-gateway-token-1234567890";

describe("Control UI assistant media e2e", () => {
  test("refuses a staged inbound reference to a request that names no session", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway e2e media fixtures");
    }
    testState.gatewayAuth = { mode: "token", token: CONTROL_UI_E2E_TOKEN };

    const inboundDir = path.join(stateDir, "media", "inbound");
    await fs.mkdir(inboundDir, { recursive: true });
    const stagedId = "staged-session-bound.png";
    await fs.writeFile(path.join(inboundDir, stagedId), "staged bytes\n", "utf8");
    // The sanitizer marks the object when it publishes it, and the session that persists
    // the result owns it. Both happen before any request, so this case is the retained
    // reference a reader keeps after they stop being authorized.
    expect(await recordStagedInboundMedia(stagedId)).toBe(true);
    expect(
      await recordInboundMediaOwner(stagedId, { sessionKey: "agent:main:dashboard:media-e2e" }),
    ).toBe(true);

    await withGatewayServer(async ({ port }) => {
      const route = "http://127.0.0.1:" + port + "/__openclaw__/assistant-media";
      const headers = { Authorization: "Bearer " + CONTROL_UI_E2E_TOKEN };

      // A staged reference names a session that this request does not, so the media route
      // refuses it instead of falling back to general reader authority over the store.
      const staged = await fetch(
        route + "?meta=1&source=" + encodeURIComponent("media://inbound/" + stagedId),
        { headers },
      );
      expect(staged.status).toBe(404);

      // Control: a managed inbound object that was never staged keeps today's access, so
      // the binding narrows staged references rather than every managed one.
      const plainId = "unstaged-channel-attachment.png";
      await fs.writeFile(path.join(inboundDir, plainId), "attachment bytes\n", "utf8");
      const plain = await fetch(
        route + "?meta=1&source=" + encodeURIComponent("media://inbound/" + plainId),
        { headers },
      );
      expect(plain.status).toBe(200);
      expect(((await plain.json()) as { available?: boolean }).available).toBe(true);
    });
  });

  test("reports a pruned inbound reference as definitively unavailable", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway e2e media fixtures");
    }
    testState.gatewayAuth = { mode: "token", token: CONTROL_UI_E2E_TOKEN };

    const inboundDir = path.join(stateDir, "media", "inbound");
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, "pruned-inline-image.png"), "inbound bytes\n", "utf8");

    await withGatewayServer(async ({ port }) => {
      const route = "http://127.0.0.1:" + port + "/__openclaw__/assistant-media";
      const headers = { Authorization: "Bearer " + CONTROL_UI_E2E_TOKEN };
      const missingId = "pruned-inline-image.png";

      // A managed inbound reference resolves while its file is present, which is what
      // lets this case repeat the same request after the store has deleted it. The
      // display projection keeps serving that reference, and nothing recreates the bytes.
      const inboundRef = "media://inbound/" + missingId;
      const prunedUrl = route + "?meta=1&source=" + encodeURIComponent(inboundRef);
      const present = await fetch(prunedUrl, { headers });
      expect(present.status).toBe(200);
      expect(((await present.json()) as { available?: boolean }).available).toBe(true);

      // The media-store TTL pruner runs; the reference outlives its file.
      await fs.rm(path.join(stateDir, "media", "inbound", missingId), { force: true });
      const pruned = await fetch(prunedUrl, { headers });
      expect(pruned.status).toBe(200);
      expect(await pruned.json()).toEqual({
        available: false,
        code: "file-not-found",
        reason: "File not found",
        retryable: false,
      });

      // The same absent bytes addressed as a local path can simply be mid-write, so the
      // control is its retryability rather than its code, which reports the path failure
      // this build produces for any missing file.
      const localPath = path.join(stateDir, "media", "inbound", missingId);
      const localUrl = route + "?meta=1&source=" + encodeURIComponent(localPath);
      const localMissing = await fetch(localUrl, { headers });
      expect(localMissing.status).toBe(200);
      const localPayload = (await localMissing.json()) as {
        available?: boolean;
        retryable?: boolean;
      };
      expect(localPayload.available).toBe(false);
      expect(localPayload.retryable).not.toBe(false);
    });
  });

  test("serves local assistant media through scoped tickets over the gateway HTTP route", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway e2e media fixtures");
    }
    testState.gatewayAuth = { mode: "token", token: CONTROL_UI_E2E_TOKEN };

    const mediaDir = path.join(stateDir, "media", "control-ui-assistant-media-e2e");
    await fs.mkdir(mediaDir, { recursive: true });
    const filePath = path.join(mediaDir, "测试 ticketed (final).txt");
    await fs.writeFile(filePath, "ticketed control ui media\n", "utf8");

    await withGatewayServer(
      async ({ port }) => {
        const route = `http://127.0.0.1:${port}/__openclaw__/assistant-media`;
        const sourceParam = encodeURIComponent(filePath);

        const metadata = await fetch(`${route}?meta=1&source=${sourceParam}`, {
          headers: { Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}` },
        });
        expect(metadata.status).toBe(200);
        const payload = (await metadata.json()) as {
          available?: boolean;
          mediaTicket?: string;
          mediaTicketExpiresAt?: string;
        };
        expect(payload.available).toBe(true);
        expect(payload.mediaTicket).toMatch(/^v1\./);
        expect(Date.parse(payload.mediaTicketExpiresAt ?? "")).not.toBeNaN();

        const withoutTicket = await fetch(`${route}?source=${sourceParam}`);
        expect(withoutTicket.status).toBe(401);

        const ticketed = await fetch(
          `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
        );
        expect(ticketed.status).toBe(200);
        expect(ticketed.headers.get("content-disposition")).toBe(
          `attachment; filename="__ ticketed (final).txt"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%20ticketed%20%28final%29.txt`,
        );
        expect(await ticketed.text()).toBe("ticketed control ui media\n");

        const fileUrl = pathToFileURL(filePath).href;
        for (const source of [
          fileUrl,
          fileUrl.replace(/^file:/u, "FILE:"),
          fileUrl.replace(/^file:\/\//u, "file:"),
          fileUrl.replace(/^file:\/\//u, "FILE:"),
        ]) {
          const equivalent = await fetch(
            `${route}?source=${encodeURIComponent(source)}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
          );
          expect(equivalent.status, source).toBe(200);
          expect(await equivalent.text()).toBe("ticketed control ui media\n");
        }
        for (const source of ["file://evil-host/etc/hostname", "FILE://evil-host/etc/hostname"]) {
          const remoteHost = await fetch(`${route}?source=${encodeURIComponent(source)}`, {
            headers: { Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}` },
          });
          expect(remoteHost.status, source).toBe(404);
        }

        const ranged = await fetch(
          `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
          { headers: { Range: "bytes=9-15" } },
        );
        expect(ranged.status).toBe(206);
        expect(ranged.headers.get("accept-ranges")).toBe("bytes");
        expect(ranged.headers.get("content-range")).toBe("bytes 9-15/26");
        expect(ranged.headers.get("content-length")).toBe("7");
        expect(ranged.headers.get("etag")).toBeNull();
        expect(ranged.headers.get("last-modified")).toBeNull();
        expect(await ranged.text()).toBe("control");

        const head = await fetch(
          `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
          { method: "HEAD" },
        );
        expect(head.status).toBe(200);
        expect(head.headers.get("accept-ranges")).toBe("bytes");
        expect(head.headers.get("content-length")).toBe("26");
        expect(head.headers.get("etag")).toBeNull();
        expect(head.headers.get("last-modified")).toBeNull();
        expect(await head.text()).toBe("");

        for (const method of ["GET", "HEAD"]) {
          const fresh = await fetch(
            `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
            {
              method,
              headers: {
                "If-None-Match": 'W/"cached-version"',
                Range: "bytes=9-15",
                "If-Range": '"stale"',
              },
            },
          );
          expect(fresh.status).toBe(200);
          expect(fresh.headers.get("etag")).toBeNull();
          expect(fresh.headers.get("content-length")).toBe("26");
          expect(await fresh.text()).toBe(method === "GET" ? "ticketed control ui media\n" : "");

          const exists = await fetch(
            `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
            { method, headers: { "If-None-Match": "*", Range: "bytes=9-15" } },
          );
          expect(exists.status).toBe(304);
          expect(exists.headers.get("content-length")).toBeNull();
          expect(await exists.text()).toBe("");
        }

        const emptyFilePath = path.join(mediaDir, "empty.bin");
        await fs.writeFile(emptyFilePath, Buffer.alloc(0));
        const empty = await fetch(`${route}?source=${encodeURIComponent(emptyFilePath)}`, {
          headers: { Authorization: `Bearer ${CONTROL_UI_E2E_TOKEN}` },
        });
        expect(empty.status).toBe(200);
        expect(empty.headers.get("content-length")).toBe("0");
        expect((await empty.arrayBuffer()).byteLength).toBe(0);

        const otherFilePath = path.join(mediaDir, "other-preview.txt");
        await fs.writeFile(otherFilePath, "other media\n", "utf8");
        const wrongSource = await fetch(
          `${route}?source=${encodeURIComponent(otherFilePath)}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
        );
        expect(wrongSource.status).toBe(401);
      },
      {
        serverOptions: {
          auth: { mode: "token", token: CONTROL_UI_E2E_TOKEN },
          controlUiEnabled: true,
        },
      },
    );
  });
});
