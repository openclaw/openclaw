import fs from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { handleControlUiHttpRequest } from "./control-ui.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const frameAncestors = ["codex-sandbox:", "https://*.web-sandbox.oaiusercontent.com"];
const script = "window.fixtureReady = true;";
let root: string;

beforeAll(() => {
  root = dirs.make("control-ui-framing-");
  fs.writeFileSync(path.join(root, "index.html"), `<html><script>${script}</script></html>`);
  fs.writeFileSync(path.join(root, "custom.html"), "<html>Custom document</html>");
  fs.writeFileSync(path.join(root, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.symlinkSync("index.html", path.join(root, "index-alias"));
});

async function request(
  route: string,
  ancestors?: string[],
  method = "GET",
  sessionEntryPath?: string,
) {
  const req = new IncomingMessage(new Socket());
  req.url = `/control${route}`;
  req.method = method;
  req.headers = { host: "gateway.example.test" };
  const res = new ServerResponse(req);
  expect(
    await handleControlUiHttpRequest(req, res, {
      basePath: "/control",
      config: { gateway: { controlUi: { frameAncestors: ancestors } } },
      root: { kind: "resolved", path: root },
      sessionEntryPath,
    }),
  ).toBe(true);
  expect(res.statusCode).toBe(200);
  return res;
}

describe("Control UI document framing", () => {
  it.each([undefined, []])("retains default CSP and XFO for %j", async (ancestors) => {
    const res = await request("/", ancestors);
    expect(res.getHeader("X-Frame-Options")).toBe("DENY");
    expect(res.getHeader("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it.each(["/", "/index.html", "/index-alias", "/settings", "/approve/request", "/custom.html"])(
    "applies the opt-in to GET and HEAD documents at %s",
    async (route) => {
      for (const method of ["GET", "HEAD"]) {
        const res = await request(route, frameAncestors, method);
        expect(res.hasHeader("X-Frame-Options")).toBe(false);
        expect(res.getHeader("Content-Security-Policy")).toContain(
          "frame-ancestors codex-sandbox: https://*.web-sandbox.oaiusercontent.com",
        );
        if (method === "GET" && route !== "/custom.html") {
          expect(res.getHeader("Content-Security-Policy")).toContain("'sha256-");
          expect(res.getHeader("Content-Security-Policy")).toContain("'wasm-unsafe-eval'");
        }
        expect(res.getHeader("Referrer-Policy")).toBe("no-referrer");
      }
    },
  );

  it("keeps the opt-in through the protected session-entry document rewrite", async () => {
    const res = await request(
      "/chat/main/topic",
      frameAncestors,
      "GET",
      "/control/chat/main/topic",
    );
    expect(res.hasHeader("X-Frame-Options")).toBe(false);
    expect(res.getHeader("Content-Security-Policy")).toContain(
      "frame-ancestors codex-sandbox: https://*.web-sandbox.oaiusercontent.com",
    );
    expect(res.getHeader("Cache-Control")).toBe("no-store");
  });

  it.each(["/share/chat/main/topic", "/favicon.svg"])(
    "keeps framing denied on the separate surface %s",
    async (route) => {
      const res = await request(route, frameAncestors);
      expect(res.getHeader("X-Frame-Options")).toBe("DENY");
      expect(res.getHeader("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    },
  );
});
