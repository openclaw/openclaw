import { writeFile } from "node:fs/promises";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import { expect, it } from "vitest";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Composer context ring session updates" });
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const viewports = captureProof
  ? [
      { width: 1440, height: 900 },
      { width: 1366, height: 768 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]
  : [{ width: 1440, height: 900 }];

suite.define(() => {
  it.each(viewports)(
    "paints context stages as the session updates ($width px)",
    async (viewport) => {
      await suite.withPage(
        { colorScheme: viewport.width === 768 ? "light" : "dark", viewport },
        async ({ page }) => {
          const sessionKey = "agent:main:context-meter";
          const session = {
            key: sessionKey,
            kind: "direct" as const,
            label: "Context usage",
            model: "demo-model",
            modelProvider: "example",
            contextTokens: 100_000,
            totalTokens: 14_000,
            totalTokensFresh: true,
            updatedAt: 1,
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessions: [session],
            agentModel: "example/demo-model",
            models: [
              { id: "demo-model", provider: "example", name: "Demo model", contextWindow: 100_000 },
            ],
            historyMessages: [
              {
                role: "assistant",
                content: "Inspect the session's context usage in the composer.",
              },
            ],
            methodResponses: {
              "cron.list": {
                jobs: [],
                snapshotRevision: "context-meter-empty",
                offset: 0,
                limit: 50,
                total: 0,
                hasMore: false,
                nextOffset: null,
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
          await gateway.waitForRequest("sessions.messages.subscribe");
          if (viewport.width <= 900) {
            await page
              .locator(".agent-chat__composer-combobox > textarea")
              .filter({ visible: true })
              .click();
          }
          const ring = page.locator(".context-ring").filter({ visible: true });
          await ring.waitFor();
          await ring.scrollIntoViewIfNeeded();

          for (const [percent, fresh, token] of [
            [14, true, "--muted"],
            [84, true, "--muted"],
            [85, true, "--warn"],
            [95, true, "--danger"],
            [95, false, "--muted"],
            [14, true, "--muted"],
          ] as const) {
            Object.assign(session, {
              totalTokens: percent * 1000,
              totalTokensFresh: fresh,
              updatedAt: session.updatedAt + 1,
            });
            await gateway.emitGatewayEvent("sessions.changed", {
              ...session,
              sessionKey,
              reason: "patch",
            });
            await expect
              .poll(() => ring.getAttribute("aria-label"))
              .toContain(`${fresh ? "" : "~"}${percent}%`);
            await waitForControlUiProofSurface(ring, [ring]);
            const ringBounds = await ring.boundingBox();
            expect(ringBounds).not.toBeNull();
            // Capture after painting so session events cannot pass on stale SVG pixels.
            const screenshot = await page.screenshot({ animations: "disabled" });
            const frame = photon.PhotonImage.new_from_byteslice(screenshot);
            const crop = (bounds: NonNullable<typeof ringBounds>) =>
              photon.crop(
                frame,
                Math.floor(bounds.x),
                Math.floor(bounds.y),
                Math.ceil(bounds.x + bounds.width),
                Math.ceil(bounds.y + bounds.height),
              );
            const image = crop(ringBounds!);
            if (captureProof) {
              const name = `${percent}-${fresh ? "fresh" : "stale"}`;
              await writeFile(path.join(suite.artifactDir, `${name}-page.png`), screenshot);
              await writeFile(path.join(suite.artifactDir, `${name}-ring.png`), image.get_bytes());
            }
            frame.free();
            const expected = await ring.evaluate((element, property) => {
              const canvas = document.createElement("canvas");
              const drawing = canvas.getContext("2d")!;
              drawing.fillStyle = getComputedStyle(element).getPropertyValue(property).trim();
              drawing.fillRect(0, 0, 1, 1);
              return [...drawing.getImageData(0, 0, 1, 1).data].slice(0, 3);
            }, token);
            // Assert visible paint, not merely the ring's inherited CSS color.
            try {
              const pixels = image.get_raw_pixels();
              let matches = 0;
              for (let offset = 0; offset < pixels.length; offset += 4) {
                if (
                  expected.every(
                    (channel, index) => Math.abs(channel - pixels[offset + index]!) <= 1,
                  )
                ) {
                  matches += 1;
                }
              }
              expect
                .soft(matches, `${percent}% ${fresh ? "fresh" : "stale"} fill uses ${token}`)
                .toBeGreaterThan(0);
            } finally {
              image.free();
            }
          }
        },
      );
    },
  );
});
