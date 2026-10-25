import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCanvasDocument } from "../canvas/documents.js";
import { saveMediaBuffer } from "../media/store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createControlUiPublicSessionRequestGate } from "./control-ui-public-session-admission.js";
import { collectPublicSessionAttachments } from "./control-ui-public-session-attachments.js";
import { serveControlUiPublicSessionMedia } from "./control-ui-public-session-media.js";
import { createRequest, createResponse } from "./server-http.test-harness.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

const { readMessage, readWidget, active, resolveToken, resolveWidgetToken } = vi.hoisted(() => ({
  readMessage: vi.fn(),
  readWidget: vi.fn(),
  active: vi.fn(),
  resolveToken: vi.fn(),
  resolveWidgetToken: vi.fn(),
}));
// mock-isolation: Public publication state is controlled while exercising real media bytes and admission.
vi.mock("./control-ui-public-session-read.js", () => ({
  readPublicSessionMessage: readMessage,
  readPublicSessionWidget: readWidget,
  isPublicSessionShareActive: active,
}));
// mock-isolation: Token cryptography is covered by its owner; this suite exercises the resolved publication boundary.
vi.mock("./control-ui-public-session-token.js", () => ({
  resolvePublicSessionShareToken: resolveToken,
  resolvePublicSessionWidgetToken: resolveWidgetToken,
}));

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5r8AAAAASUVORK5CYII=",
  "base64",
);
const locator = {
  agentId: "main",
  sessionKey: "agent:main:public",
  sessionId: "public-generation",
  shareId: "a".repeat(48),
};
const config = { agents: { entries: { main: {} } } };
const projection = createSessionRowProjectionFixture({ cfg: config, store: {} });
const gates: ReturnType<typeof createControlUiPublicSessionRequestGate>[] = [];

function message(data = png.toString("base64")) {
  return {
    role: "user",
    __openclaw: { id: "entry-1" },
    content: [{ type: "image", data, mimeType: "image/png", fileName: "diagram.png" }],
  };
}

async function request(
  options: {
    query?: string;
    remote?: boolean;
    gate?: ReturnType<typeof createControlUiPublicSessionRequestGate>;
    headers?: Record<string, string>;
  } = {},
  status = 200,
  body?: string,
) {
  const gate = options.gate ?? createControlUiPublicSessionRequestGate();
  if (!options.gate) {
    gates.push(gate);
  }
  const response = createResponse();
  await serveControlUiPublicSessionMedia({
    req: createRequest({
      path: `/control/share/session/media?${options.query ?? "token=v1.YWJj&entry=entry-1&attachment=content-0"}`,
      host: options.remote ? "gateway.example.test" : "127.0.0.1:18789",
      headers: options.headers,
    }),
    res: response.res,
    basePath: "/control",
    config,
    projection,
    gate,
    ingress: {
      kind: options.remote ? "direct-remote" : "direct-local",
      clientIp: "127.0.0.1",
      rateLimit: { subject: { key: "client" }, resetOnSuccess: true },
    },
  });
  expect(response.res.statusCode).toBe(status);
  if (body !== undefined) {
    expect(response.getBody()).toBe(body);
  }
  return response;
}

function storedMedia(media: unknown[]) {
  return { role: "user", __openclaw: { id: "entry-1", media } };
}

beforeEach(() => {
  resolveToken.mockReset().mockResolvedValue(locator);
  resolveWidgetToken.mockReset().mockResolvedValue(null);
  active.mockReset().mockReturnValue(true);
  readMessage.mockReset().mockResolvedValue(message());
  readWidget.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  for (const gate of gates.splice(0)) {
    gate.dispose();
  }
});

describe("public session media", () => {
  it("serves only token-bound published widgets and rechecks publication before every response", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const query = "widget=v1.widget";
      const privateDocument = await createCanvasDocument({ html: "<p>Private chart</p>" });
      resolveWidgetToken.mockResolvedValue({ locator, docId: privateDocument.id });
      await request({ query }, 404);
      const html = "<!doctype html><p>Shared chart</p><script>document.title = 'Chart'</script>";
      const document = await createCanvasDocument({ html, cspSandbox: "scripts" });
      const other = await createCanvasDocument({ html: "<p>Other</p>", cspSandbox: "scripts" });
      resolveWidgetToken.mockResolvedValue({ locator, docId: document.id });
      readWidget.mockResolvedValue(false);
      await request({ query }, 404);
      readWidget.mockResolvedValue(true);
      const gate = createControlUiPublicSessionRequestGate();
      gates.push(gate);
      const response = await request({ query, gate }, 200, html);
      await request({ query: `${query}&widget=${other.id}` }, 404);
      await request({ query: `token=v1.YWJj&widget=${other.id}` }, 404);
      expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "text/html; charset=utf-8");
      expect(response.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
      expect(response.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
      expect(response.setHeader).toHaveBeenCalledWith("X-Robots-Tag", "noindex, nofollow");
      expect(response.setHeader).toHaveBeenCalledWith("X-Content-Type-Options", "nosniff");
      const policy = response.setHeader.mock.calls.find(
        ([name]) => name === "Content-Security-Policy",
      )?.[1];
      // The opaque sandbox, closed network, and same-origin embedding are the public contract.
      for (const directive of [
        "default-src 'none'",
        "connect-src 'none'",
        "frame-src 'none'",
        "sandbox allow-scripts",
        "frame-ancestors 'self'",
      ]) {
        expect(String(policy).split("; ")).toContain(directive);
      }
      expect(String(policy)).not.toContain("allow-same-origin");
      const etag = response.setHeader.mock.calls.find(([name]) => name === "ETag")?.[1];
      expect(etag).toEqual(expect.any(String));
      await request({ query, gate, headers: { "if-none-match": etag } }, 304, "");
      readWidget.mockImplementationOnce(async () => {
        active.mockReturnValue(false);
        return true;
      });
      const revokedDuringRead = await request({ query }, 404, "This widget is unavailable.");
      expect(revokedDuringRead.setHeader).not.toHaveBeenCalledWith("ETag", expect.anything());
      await request(
        { query, gate, headers: { "if-none-match": etag } },
        404,
        "This widget is unavailable.",
      );
      active.mockReturnValue(true);
      resolveWidgetToken.mockResolvedValue({ locator, docId: "missing" });
      await request({ query }, 404);
    });
  });

  it.each([
    "widget=chart&entry=entry-1&attachment=content-0",
    "widget=chart&widget=other",
    "entry=entry-1&attachment=content-0&extra=1",
  ])("rejects ambiguous or invalid public media query: %s", async (query) => {
    await request({ query: `token=v1.YWJj&${query}` }, 404);
    expect(readWidget).not.toHaveBeenCalled();
    expect(readMessage).not.toHaveBeenCalled();
  });

  it("serves exact entry images with sniffed type, inline disposition, and private cache policy", async () => {
    readMessage.mockResolvedValue({ ...message(), role: "toolResult", toolCallId: "tool-1" });
    const response = await request();
    expect(response.end).toHaveBeenCalledWith(png);
    expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "image/png");
    expect(response.setHeader).toHaveBeenCalledWith("Content-Disposition", "inline");
  });

  it("reads user attachments through the managed inbound media owner", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const save = (directory: string, name: string) =>
        saveMediaBuffer(png, "image/png", directory, MAX_IMAGE_BYTES, name);
      const saved = await save("inbound", "upload.png");
      for (const source of [{ url: `media://inbound/${saved.id}` }, { path: saved.path }]) {
        readMessage.mockResolvedValue(storedMedia([{}, { ...source, fileName: "upload.png" }]));
        const response = await request({ query: "token=v1.YWJj&entry=entry-1&attachment=media-1" });
        expect(response.end).toHaveBeenCalledWith(png);
      }
      const outside = await save("outgoing/originals", "private.png");
      readMessage.mockResolvedValue(
        storedMedia([{ path: outside.path, contentType: "image/png" }]),
      );
      await request({ query: "token=v1.YWJj&entry=entry-1&attachment=media-0" }, 404);
    });
  });

  it("never publishes image-looking SVG, oversized bytes, hidden messages, or another attachment", async () => {
    for (const value of [
      message(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")),
      message(Buffer.alloc(MAX_IMAGE_BYTES + 1).toString("base64")),
      { ...message(), display: false },
      { ...message(), role: "custom" },
      { ...message(), content: [{ type: "text", text: "private tool result" }] },
      { ...message(), __openclaw: { id: "different-entry" } },
    ]) {
      readMessage.mockResolvedValue(value);
      await request({}, 404, "This public session is unavailable.");
    }
  });

  it("refuses unknown tokens and insecure ingress before reading transcript bytes", async () => {
    resolveToken.mockResolvedValue(null);
    await request({}, 404);
    expect(readMessage).not.toHaveBeenCalled();
    resolveToken.mockResolvedValue(locator);
    await request({ remote: true }, 404);
    expect(readMessage).not.toHaveBeenCalled();
  });

  it("uses the shared client and publication budgets", async () => {
    const gate = createControlUiPublicSessionRequestGate();
    gates.push(gate);
    for (let index = 0; index < 120; index++) {
      gate.admitClient("client");
    }
    await request({ gate }, 429);
    expect(readMessage).not.toHaveBeenCalled();
  });

  it("projects source-free descriptors and excludes non-image tool results", () => {
    const entry = {
      role: "user",
      content: [
        null,
        { type: "attachment", attachment: { kind: "document", label: "generated.pdf" } },
      ],
      __openclaw: {
        id: "entry-2",
        media: [
          null,
          { url: "media://inbound/private-image.png", kind: "image", fileName: "photo.png" },
          { url: "media://inbound/private-file.pdf", kind: "document", fileName: "notes.pdf" },
        ],
      },
    };
    expect(collectPublicSessionAttachments(entry)).toEqual([
      { id: "content-1", name: "generated.pdf", image: false },
      { id: "media-1", name: "photo.png", image: true },
      { id: "media-2", name: "notes.pdf", image: false },
    ]);
    expect(collectPublicSessionAttachments({ ...entry, role: "toolResult" })).toEqual([
      { id: "media-1", name: "photo.png", image: true },
    ]);
  });
});
