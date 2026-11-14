import { afterEach, expect, it, vi } from "vitest";
import { setOpenClawIdClawOriginResolver } from "../openclaw-id/claw-origin.js";
import { makeClient } from "../server-broadcast.test-helpers.js";
import { respondSessionFilePreview } from "./sessions-file-preview.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

afterEach(() => setOpenClawIdClawOriginResolver(undefined));

const policy =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><script defer src="app.js"></script></head><body>Preview</body></html>`;

async function preview(tunnel: boolean) {
  setOpenClawIdClawOriginResolver(() => "https://fsn1-r7pd5.crabd.xyz");
  const { client } = makeClient("preview", "operator", ["operator.read"]);
  client.connId = "preview-conn";
  client.connectionSignal = new AbortController().signal;
  if (tunnel) {
    client.browserOrigin = { openclawIdTunnel: true };
  }
  const respond = vi.fn();
  const readAssets = vi.fn(async (refs: string[]) => ({
    assets: refs.map((ref) => ({
      ref,
      mimeType: "text/javascript",
      content: Buffer.from("window.previewReady = true;").toString("base64"),
    })),
  }));
  const onGrantCreated = vi.fn();
  await respondSessionFilePreview({
    options: {
      client,
      respond,
      context: { getRuntimeConfig: () => ({}) },
    } as unknown as GatewayRequestHandlerOptions,
    params: { sessionKey: "agent:main:main", path: "index.html", html },
    readAssets,
    assertCurrent: () => {},
    release: () => {},
    onGrantCreated,
  });
  return { result: respond.mock.calls[0]?.[1], onGrantCreated };
}

it("refuses relative-resource previews on claw-loader sandboxes without creating a grant", async () => {
  const { result, onGrantCreated } = await preview(true);
  expect(result).toEqual({ status: "unsupported", html, omitted: 0 });
  expect(onGrantCreated).not.toHaveBeenCalled();
});

it("keeps the Gateway resource grant for connections outside the OpenClaw ID tunnel", async () => {
  const { result, onGrantCreated } = await preview(false);
  expect(result).toMatchObject({ status: "ready", html });
  expect(result).toHaveProperty("previewId");
  expect(onGrantCreated).toHaveBeenCalledOnce();
});
