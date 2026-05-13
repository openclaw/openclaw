import { describe, expect, test } from "vitest";
import { deleteMediaBuffer, saveMediaBuffer } from "../media/store.js";
import { installGatewayTestHooks, testState, withGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const CONTROL_UI_E2E_TOKEN = "test-gateway-token-1234567890";

describe("Control UI assistant media e2e", () => {
  test("serves SQLite assistant media through scoped tickets over the gateway HTTP route", async () => {
    testState.gatewayAuth = { mode: "token", token: CONTROL_UI_E2E_TOKEN };

    const saved = await saveMediaBuffer(Buffer.from("ticketed control ui media\n"), "text/plain");
    const other = await saveMediaBuffer(Buffer.from("other media\n"), "text/plain");

    try {
      await withGatewayServer(
        async ({ port }) => {
          const route = `http://127.0.0.1:${port}/__openclaw__/assistant-media`;
          const source = `media://inbound/${saved.id}`;
          const sourceParam = encodeURIComponent(source);

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
          expect(await ticketed.text()).toBe("ticketed control ui media\n");

          const wrongSource = await fetch(
            `${route}?source=${encodeURIComponent(`media://inbound/${other.id}`)}` +
              `&mediaTicket=${encodeURIComponent(payload.mediaTicket ?? "")}`,
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
    } finally {
      await deleteMediaBuffer(saved.id).catch(() => {});
      await deleteMediaBuffer(other.id).catch(() => {});
    }
  });
});
