import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { computeInlineScriptHashes } from "./control-ui-csp.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import { createRequest, createResponse } from "./server-http.test-harness.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
beforeEach(() => {
  setRuntimeConfigSnapshot({});
  root = dirs.make("session-entry-document-");
  fs.writeFileSync(
    path.join(root, "index.html"),
    '<!doctype html><html><head><script type="module" src="./assets/app.js"></script></head><body><openclaw-app></openclaw-app></body></html>',
  );
});
afterEach(() => clearRuntimeConfigSnapshot());

type DocumentOptions = NonNullable<Parameters<typeof handleControlUiHttpRequest>[2]>;
async function document(options: DocumentOptions = {}, gzip = false) {
  const response = createResponse();
  const handled = await handleControlUiHttpRequest(
    createRequest({
      path: options.sessionEntryPath ?? "/control/",
      host: "localhost",
      headers: gzip ? { "accept-encoding": "gzip" } : {},
    }),
    response.res,
    { basePath: "/control", root: { kind: "resolved", path: root }, ...options },
  );
  expect(handled).toBe(true);
  return response;
}

it.each(["token", "password", "trusted-proxy"] as const)(
  "opts only proxy-authenticated app documents into direct chat navigation: %s",
  async (mode) => {
    const response = await document({ auth: { mode, allowTailscale: false } });
    expect(response.getBody().includes('data-openclaw-proxy-session-entry="true"')).toBe(
      mode === "trusted-proxy",
    );
  },
);

it("restores the mounted canonical path before SPA scripts with the full app CSP", async () => {
  const canonical = "/control/chat/main/topic";
  const current = vi.fn(() => true);
  const response = await document({ sessionEntryPath: canonical, isSessionEntryCurrent: current });
  const html = response.getBody();
  expect(html).toContain(`history.replaceState(null,"","${canonical}"+location.hash)`);
  expect(html.indexOf("history.replaceState")).toBeLessThan(html.indexOf('type="module"'));
  expect(html).toContain('src="/control/assets/app.js"');
  expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  const headers = response.setHeader.mock.calls;
  const csp = headers.findLast(([name]) => name === "Content-Security-Policy")?.[1];
  expect(csp).toContain("connect-src 'self' ws: wss:");
  for (const hash of computeInlineScriptHashes(html)) {
    expect(csp).toContain(hash);
  }
  expect(current).toHaveBeenCalled();

  const isSessionEntryCurrent = () => false;
  const revoked = await document({ sessionEntryPath: canonical, isSessionEntryCurrent }, true);
  expect(revoked.getBody()).toContain("Session access changed");
  const plain = await document({ isSessionEntryCurrent }, true);
  for (const denied of [revoked, plain]) {
    expect(denied.res.statusCode).toBe(403);
    expect(denied.setHeader).not.toHaveBeenCalledWith("Location", expect.anything());
    expect(denied.getBody()).not.toContain("openclaw-app");
  }
});
