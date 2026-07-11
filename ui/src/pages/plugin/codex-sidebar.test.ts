import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { CodexSidebar } from "./codex-sidebar.ts";

describe("Codex sidebar", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("groups non-archived sessions from every host and opens the selected transcript", async () => {
    const request = vi.fn(async () => ({
      hosts: [
        {
          hostId: "gateway:local",
          label: "Local Codex",
          kind: "gateway",
          connected: true,
          sessions: [{ threadId: "local-1", name: "Local task", status: "idle", archived: false }],
        },
        {
          hostId: "node:macbook",
          label: "MacBook",
          kind: "node",
          connected: true,
          sessions: [
            { threadId: "remote-1", name: "Remote task", status: "idle", archived: false },
          ],
        },
      ],
    }));
    const open = vi.fn();
    const sidebar = new CodexSidebar();
    sidebar.client = { request } as unknown as GatewayBrowserClient;
    sidebar.connected = true;
    sidebar.onOpenSession = open;
    document.body.append(sidebar);

    await vi.waitFor(() =>
      expect(sidebar.querySelectorAll("[data-codex-thread-id]")).toHaveLength(2),
    );
    expect(sidebar.textContent).toContain("Local Codex");
    expect(sidebar.textContent).toContain("MacBook");
    (sidebar.querySelector('[data-codex-thread-id="remote-1"]') as HTMLElement).click();
    expect(open).toHaveBeenCalledWith("node:macbook", "remote-1");
  });

  it("loads every bounded catalog page so all active sessions appear", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        hosts: [
          {
            hostId: "node:macbook",
            label: "MacBook",
            kind: "node",
            connected: true,
            sessions: [
              { threadId: "remote-1", name: "Recent task", status: "idle", archived: false },
            ],
            nextCursor: "catalog-page-2",
          },
        ],
      })
      .mockResolvedValueOnce({
        hosts: [
          {
            hostId: "node:macbook",
            label: "MacBook",
            kind: "node",
            connected: true,
            sessions: [
              { threadId: "remote-2", name: "Older task", status: "idle", archived: false },
            ],
          },
        ],
      });
    const sidebar = new CodexSidebar();
    sidebar.client = { request } as unknown as GatewayBrowserClient;
    sidebar.connected = true;
    document.body.append(sidebar);

    await vi.waitFor(() =>
      expect(sidebar.querySelectorAll("[data-codex-thread-id]")).toHaveLength(2),
    );
    expect(request).toHaveBeenNthCalledWith(1, "codex.sessions.list", { limitPerHost: 40 });
    expect(request).toHaveBeenNthCalledWith(2, "codex.sessions.list", {
      limitPerHost: 40,
      hostIds: ["node:macbook"],
      cursors: { "node:macbook": "catalog-page-2" },
    });
  });

  it("stops automatic catalog hydration at a fixed per-host budget", async () => {
    let page = 0;
    const request = vi.fn(async () => {
      page += 1;
      return {
        hosts: [
          {
            hostId: "node:macbook",
            label: "MacBook",
            kind: "node",
            connected: true,
            sessions: [
              {
                threadId: `remote-${page}`,
                name: `Task ${page}`,
                status: "idle",
                archived: false,
              },
            ],
            nextCursor: `catalog-page-${page + 1}`,
          },
        ],
      };
    });
    const sidebar = new CodexSidebar();
    sidebar.client = { request } as unknown as GatewayBrowserClient;
    sidebar.connected = true;
    document.body.append(sidebar);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(100));
    expect(sidebar.querySelectorAll("[data-codex-thread-id]")).toHaveLength(100);
    expect(sidebar.textContent).toContain("More sessions are available in the full catalog.");
  });
});
