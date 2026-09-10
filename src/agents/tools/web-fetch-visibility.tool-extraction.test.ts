import type { Server } from "node:http";
import { createServer } from "node:http";
// Tool-level visibility proof: a real HTTP transfer through the real web_fetch
// execute path (basic extraction, which runs the visibility sanitizer) must
// keep visible content and drop hidden content. The unit tests in
// web-fetch-visibility.test.ts pin the sanitizer; this file pins the user
// visible web_fetch output.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { LookupFn } from "../../infra/net/ssrf.js";
import { createWebFetchTool } from "./web-fetch.js";

const PAGES: Record<string, string> = {
  "/framework-attrs": [
    "<html><head><title>Framework Attributes</title></head><body>",
    "<p>Pricing starts at nine dollars.</p>",
    '<div @click="noop" hidden>Secret framework note</div>',
    '<div (click)="noop" class="hidden">Secret class note</div>',
    "<p>Support is available around the clock.</p>",
    "</body></html>",
  ].join(""),
  "/nested-list": [
    "<html><head><title>Nested List</title></head><body>",
    "<p>Menu overview follows.</p>",
    "<ul><li hidden>Outer<ul><li>Secret list note</li></ul></li></ul>",
    "<p>Menu overview ends.</p>",
    "</body></html>",
  ].join(""),
  "/stray-closer": [
    "<html><head><title>Stray Closer</title></head><body>",
    "<div hidden>Before</span>Secret stray note</div>",
    "<p>Visible article body.</p>",
    "</body></html>",
  ].join(""),
};

async function startPageServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const page = PAGES[req.url ?? ""];
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected a loopback TCP address for the page server");
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

describe("web_fetch visibility through the real tool execute path", () => {
  let server: Server;
  let baseUrl: string;
  const lookupMock = vi.fn();

  beforeAll(async () => {
    ({ server, baseUrl } = await startPageServer());
    lookupMock.mockImplementation(async (hostname: string) => {
      void hostname;
      return [{ address: "127.0.0.1", family: 4 }];
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function createTool(): ReturnType<typeof createWebFetchTool> {
    return createWebFetchTool({
      lookupFn: lookupMock as unknown as LookupFn,
      config: {
        // The visibility sanitizer runs on the basic-extraction fallback path
        // (no plugin content extractors); this proof exercises that path.
        plugins: { enabled: false },
        tools: {
          web: {
            fetch: {
              cacheTtlMinutes: 0,
              ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
            },
          },
        },
      },
    });
  }

  async function extract(path: string): Promise<string> {
    const result = await createTool()?.execute?.("call", { url: `${baseUrl}${path}` });
    const details = result?.details as { text?: string } | undefined;
    expect(details?.text, "web_fetch should return extracted text").toBeTruthy();
    return details?.text ?? "";
  }

  it("keeps visible content and drops hidden content after framework attributes", async () => {
    const text = await extract("/framework-attrs");
    expect(text).toContain("Pricing starts at nine dollars.");
    expect(text).toContain("Support is available around the clock.");
    expect(text).not.toContain("Secret framework note");
    expect(text).not.toContain("Secret class note");
  });

  it("keeps the hidden region open across a nested same-name descendant", async () => {
    const text = await extract("/nested-list");
    expect(text).toContain("Menu overview follows.");
    expect(text).toContain("Menu overview ends.");
    expect(text).not.toContain("Outer");
    expect(text).not.toContain("Secret list note");
  });

  it("does not release a hidden region on a stray closing tag", async () => {
    const text = await extract("/stray-closer");
    expect(text).toContain("Visible article body.");
    expect(text).not.toContain("Before");
    expect(text).not.toContain("Secret stray note");
  });
});
