import fs from "node:fs";
import { createServer, request } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import { readControlUiE2eDownload } from "../test-helpers/control-ui-e2e-download.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { captureUiProofEnabled, chatMessage } from "./chat-flow.test-support.ts";
import { exactButton, polledCount } from "./chat-presentation.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Session file PDFs",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:main";

// A complete one-page PDF, including byte-correct xref offsets; padding lives in its stream.
function pdfFixture(padding: number) {
  const stream = `BT /F1 24 Tf 50 700 Td (Session file PDF preview) Tj ET\n%${" ".repeat(padding)}\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

suite.define(() => {
  it("previews linked PDFs above and below the inline cap and downloads fresh bytes", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const files = [
        { name: "small.pdf", bytes: pdfFixture(0) },
        { name: "report.pdf", bytes: pdfFixture(300 * 1024) },
      ];
      // Browser-managed downloads bypass Playwright routes, so serve real PDF bytes
      // on the same origin as the unchanged production UI.
      const server = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((req, res) => {
            const file = files.find(
              (entry) => req.url === `/api/artifacts/download/pdf-fixture/${entry.name}`,
            );
            if (file) {
              res.writeHead(200, {
                "content-type": "application/pdf",
                "content-length": file.bytes.length,
                "content-disposition": `attachment; filename="${file.name}"`,
                "x-content-type-options": "nosniff",
              });
              res.end(file.bytes);
              return;
            }
            const upstream = request(
              new URL(req.url ?? "/", suite.server.baseUrl),
              {
                method: req.method,
                headers: { ...req.headers, host: new URL(suite.server.baseUrl).host },
              },
              (response) => {
                res.writeHead(response.statusCode ?? 502, response.headers);
                response.pipe(res);
              },
            );
            upstream.on("error", () => res.destroy());
            res.once("close", () => upstream.destroy());
            req.pipe(upstream);
          }),
      });
      try {
        const gateway = await installMockGateway(page, {
          historyMessages: [
            chatMessage(
              "assistant",
              "Open [small.pdf](/workspace/small.pdf) or [report.pdf](/workspace/report.pdf).",
              { timestamp: 1 },
            ),
          ],
          methodResponses: {
            "sessions.files.get": {
              cases: files.map((file) => ({
                match: { path: `/workspace/${file.name}` },
                response: {
                  sessionKey,
                  root: "/workspace",
                  file: {
                    path: file.name,
                    workspacePath: file.name,
                    name: file.name,
                    kind: "read",
                    missing: false,
                    previewKind: "unsupported",
                    mimeType: "application/pdf",
                    size: file.bytes.length,
                  },
                },
              })),
            },
            "sessions.files.list": {
              sessionKey,
              root: "/workspace",
              files: [],
              browser: {
                path: "",
                entries: files.map((file) => ({ kind: "file", path: file.name, name: file.name })),
              },
            },
          },
        });
        await page.goto(`http://127.0.0.1:${server.claim.port}/chat`);
        for (const file of files) {
          const url = `/api/artifacts/download/pdf-fixture/${file.name}`;
          await gateway.setMethodResponse("sessions.files.download", {
            url,
            filename: file.name,
            mimeType: "application/pdf",
            expiresAt: "2099-01-01T00:00:00Z",
          });
          await page.locator(`.chat-thread a[data-file-path="/workspace/${file.name}"]`).click();
          const panel = page.locator("openclaw-chat-detail-panel");
          const frame = panel.locator(".sidebar-pdf-preview__frame");
          if (captureUiProofEnabled) {
            const content = panel.locator(".sidebar-pdf-preview__frame, [role=status]").first();
            await content.waitFor();
            const shot = await takeControlUiScreenshotFrame(page, panel, [content], {
              animations: "disabled",
            });
            fs.writeFileSync(path.join(suite.artifactDir, `${file.name}.png`), shot.png);
            console.log(`PDF screenshot: ${path.join(suite.artifactDir, `${file.name}.png`)}`);
          }
          await polledCount(frame).toBe(1);
          expect(await frame.getAttribute("src")).toMatch(/^blob:/);
          const [download] = await Promise.all([
            page.waitForEvent("download"),
            panel.getByRole("button", { name: "Download file", exact: true }).click(),
          ]);
          expect(download.suggestedFilename()).toBe(file.name);
          expect((await readControlUiE2eDownload(download)).equals(file.bytes)).toBe(true);
          expect((await gateway.getRequests("sessions.files.download")).at(-1)?.params).toEqual({
            sessionKey,
            agentId: "main",
            path: `/workspace/${file.name}`,
          });
          await exactButton(page, `Close tab: ${file.name}`).click();
          await panel.waitFor({ state: "detached" });
        }
        await openChatSidePanelType(page, "Files");
        await gateway.setMethodResponse("sessions.files.get", {
          sessionKey,
          root: "/workspace",
          file: {
            path: "report.pdf",
            workspacePath: "report.pdf",
            name: "report.pdf",
            kind: "read",
            missing: false,
            previewKind: "unsupported",
            mimeType: "application/pdf",
            size: files[1]!.bytes.length,
          },
        });
        await page
          .getByRole("complementary", { name: "Session workspace", exact: true })
          .getByRole("button", { name: "report.pdf", exact: true })
          .click();
        await polledCount(page.locator(".sidebar-pdf-preview__frame")).toBe(1);
        expect((await gateway.getRequests("sessions.files.download")).at(-1)?.params).toMatchObject(
          {
            path: "/workspace/report.pdf",
          },
        );
      } finally {
        server.listener.closeAllConnections();
        await server.releaseListener();
        await server.claim.release();
      }
    });
  });
});
