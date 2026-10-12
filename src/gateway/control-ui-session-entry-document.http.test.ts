import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { computeInlineScriptHashes } from "./control-ui-csp.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import { createRequest, createResponse } from "./server-http.test-harness.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["token", "password", "trusted-proxy"] as const)(
  "opts only proxy-authenticated app documents into direct chat navigation: %s",
  async (mode) => {
    const root = dirs.make("session-entry-navigation-");
    fs.writeFileSync(
      path.join(root, "index.html"),
      "<!doctype html><html><head></head><body></body></html>",
    );
    const response = createResponse();
    await handleControlUiHttpRequest(
      createRequest({ path: "/control/", host: "localhost" }),
      response.res,
      {
        basePath: "/control",
        root: { kind: "resolved", path: root },
        auth: { mode, allowTailscale: false },
      },
    );
    expect(response.getBody().includes('data-openclaw-proxy-session-entry="true"')).toBe(
      mode === "trusted-proxy",
    );
  },
);

it("restores the mounted canonical path before SPA scripts with the full app CSP", async () => {
  const root = dirs.make("session-entry-document-");
  fs.writeFileSync(
    path.join(root, "index.html"),
    '<!doctype html><html><head><script type="module" src="./assets/app.js"></script></head><body><openclaw-app></openclaw-app></body></html>',
  );
  const canonical = "/control/chat/main/topic";
  const request = createRequest({ path: canonical, host: "localhost" });
  const response = createResponse();
  const current = vi.fn(() => true);
  expect(
    await handleControlUiHttpRequest(request, response.res, {
      basePath: "/control",
      root: { kind: "resolved", path: root },
      sessionEntryPath: canonical,
      isSessionEntryCurrent: current,
    }),
  ).toBe(true);
  const html = response.getBody();
  expect(html).toContain(`history.replaceState(null,"","${canonical}"+location.hash)`);
  expect(html.indexOf("history.replaceState")).toBeLessThan(html.indexOf('type="module"'));
  expect(html).toContain('src="/control/assets/app.js"');
  expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  const csp = response.setHeader.mock.calls.findLast(
    ([name]) => name === "Content-Security-Policy",
  )?.[1];
  expect(csp).toContain("connect-src 'self' ws: wss:");
  for (const hash of computeInlineScriptHashes(html)) {
    expect(csp).toContain(hash);
  }
  expect(current).toHaveBeenCalled();

  const revoked = createResponse();
  await handleControlUiHttpRequest(
    createRequest({ path: canonical, host: "localhost", headers: { "accept-encoding": "gzip" } }),
    revoked.res,
    {
      basePath: "/control",
      root: { kind: "resolved", path: root },
      sessionEntryPath: canonical,
      isSessionEntryCurrent: () => false,
    },
  );
  expect(revoked.res.statusCode).toBe(403);
  expect(revoked.getBody()).not.toContain("openclaw-app");
});
