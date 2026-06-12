import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const MEDIA_AUTH_TOKEN = "media-auth-gateway-token-1234567890";

// Regression: the assistant-media route must NOT accept the gateway shared secret
// via the URL query string (?token=...) — tokens in URLs leak through proxy/access
// logs, browser history, and Referer. Legitimate access is an Authorization: Bearer
// header (programmatic clients) or the signed, source-scoped mediaTicket (browsers).
describe("assistant-media auth: query token rejected, header + ticket accepted", () => {
  test("rejects ?token= even when it is the correct gateway secret", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for gateway e2e media fixtures");
    }
    testState.gatewayAuth = { mode: "token", token: MEDIA_AUTH_TOKEN };

    const mediaDir = path.join(stateDir, "media", "assistant-media-query-token-regression");
    await fs.mkdir(mediaDir, { recursive: true });
    const filePath = path.join(mediaDir, "preview.txt");
    await fs.writeFile(filePath, "assistant media body\n", "utf8");

    await withGatewayServer(
      async ({ port }) => {
        const route = `http://127.0.0.1:${port}/__openclaw__/assistant-media`;
        const sourceParam = encodeURIComponent(filePath);

        // No credential is rejected.
        const anon = await fetch(`${route}?source=${sourceParam}`);
        expect(anon.status).toBe(401);

        // The correct gateway secret in the query string is rejected (the fix).
        const queryToken = await fetch(`${route}?source=${sourceParam}&token=${MEDIA_AUTH_TOKEN}`);
        expect(queryToken.status).toBe(401);

        // Authorization: Bearer header is the legitimate programmatic path.
        const header = await fetch(`${route}?source=${sourceParam}`, {
          headers: { Authorization: `Bearer ${MEDIA_AUTH_TOKEN}` },
        });
        expect(header.status).toBe(200);
        expect(await header.text()).toBe("assistant media body\n");

        // The signed mediaTicket is the legitimate browser path: an authenticated
        // meta request mints a ticket, which then authorizes the media fetch with
        // no token in the URL.
        const meta = await fetch(`${route}?meta=1&source=${sourceParam}`, {
          headers: { Authorization: `Bearer ${MEDIA_AUTH_TOKEN}` },
        });
        expect(meta.status).toBe(200);
        const payload = (await meta.json()) as { available?: boolean; mediaTicket?: string };
        expect(payload.available).toBe(true);
        expect(payload.mediaTicket).toMatch(/^v1\./);

        const ticketed = await fetch(
          `${route}?source=${sourceParam}&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
        );
        expect(ticketed.status).toBe(200);
        expect(await ticketed.text()).toBe("assistant media body\n");
      },
      {
        serverOptions: {
          auth: { mode: "token", token: MEDIA_AUTH_TOKEN },
          controlUiEnabled: true,
        },
      },
    );
  });
});
