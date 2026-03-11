import { afterEach, describe, expect, it, vi } from "vitest";
import { extractNotionPageId, NotionClient, resolveNotionToken } from "./notion-client.js";

const originalFetch = globalThis.fetch;

describe("notion-client", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.NOTION_TOKEN;
    delete process.env.NOTION_API_KEY;
    delete process.env.OPENCLAW_SKILL_NOTION_API_KEY;
  });

  it("extracts page ids from notion urls", () => {
    expect(
      extractNotionPageId(
        "https://www.notion.so/Construction-Knowledge-Platform-Storyboard-Hub-3182cb8d0fb481c08f55c19d7c9bd4f5?source=copy_link",
      ),
    ).toBe("3182cb8d-0fb4-81c0-8f55-c19d7c9bd4f5");
  });

  it("resolves notion tokens from fallback env vars", () => {
    process.env.NOTION_TOKEN = "ntn_test";
    expect(resolveNotionToken({})).toBe("ntn_test");
  });

  it("fetches live notion pages without a cache file", async () => {
    process.env.NOTION_TOKEN = "ntn_test";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.includes("/v1/pages/3182cb8d-0fb4-81c0-8f55-c19d7c9bd4f5")) {
        return new Response(
          JSON.stringify({
            id: "3182cb8d-0fb4-81c0-8f55-c19d7c9bd4f5",
            url: "https://www.notion.so/Construction-Knowledge-Platform-Storyboard-Hub-3182cb8d0fb481c08f55c19d7c9bd4f5",
            last_edited_time: "2026-03-10T04:59:00.000Z",
            properties: {
              title: {
                type: "title",
                title: [{ plain_text: "Construction Knowledge Platform Storyboard Hub" }],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/blocks/3182cb8d-0fb4-81c0-8f55-c19d7c9bd4f5/children")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "block-1",
                type: "heading_1",
                has_children: false,
                heading_1: {
                  rich_text: [{ plain_text: "Construction Knowledge Platform Storyboard Hub" }],
                },
              },
              {
                id: "block-2",
                type: "paragraph",
                has_children: false,
                paragraph: {
                  rich_text: [
                    {
                      plain_text:
                        "This hub tracks the active discovery-first Moore Bass pilot corpus.",
                    },
                  ],
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: `Unexpected URL ${url}` }), { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const client = new NotionClient();
    const page = await client.fetchPage(
      "https://www.notion.so/Construction-Knowledge-Platform-Storyboard-Hub-3182cb8d0fb481c08f55c19d7c9bd4f5",
    );

    expect(page.title).toBe("Construction Knowledge Platform Storyboard Hub");
    expect(page.summary).toContain("active discovery-first Moore Bass pilot corpus");
    expect(page.markdown).toContain("# Construction Knowledge Platform Storyboard Hub");
    expect(page.relevantScreens).toEqual(["Construction Knowledge Platform Storyboard Hub"]);
  });

  it("does not recurse into child pages when reading storyboard hubs", async () => {
    process.env.NOTION_TOKEN = "ntn_test";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
      if (url.includes("/v1/pages/3182cb8d-0fb4-81c0-8f55-c19d7c9bd4f5")) {
        return new Response(
          JSON.stringify({
            id: "3182cb8d-0fb4-81c0-8f55-c19d7c9bd4f5",
            url: "https://www.notion.so/Construction-Knowledge-Platform-Storyboard-Hub-3182cb8d0fb481c08f55c19d7c9bd4f5",
            last_edited_time: "2026-03-10T04:59:00.000Z",
            properties: {
              title: {
                type: "title",
                title: [{ plain_text: "Construction Knowledge Platform Storyboard Hub" }],
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/v1/blocks/3182cb8d-0fb4-81c0-8f55-c19d7c9bd4f5/children")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "child-page-1",
                type: "child_page",
                has_children: true,
                child_page: {
                  title: "Moore Bass 02 - Pilot Home Dashboard",
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ message: `Unexpected URL ${url}` }), { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const client = new NotionClient();
    const page = await client.fetchPage(
      "https://www.notion.so/Construction-Knowledge-Platform-Storyboard-Hub-3182cb8d0fb481c08f55c19d7c9bd4f5",
    );

    expect(page.markdown).toContain("Moore Bass 02 - Pilot Home Dashboard");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
