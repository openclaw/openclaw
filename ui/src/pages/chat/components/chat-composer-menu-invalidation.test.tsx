/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import type {
  ChatComposerPlusMenuProps,
  ChatComposerPlusMenuView,
} from "./chat-composer-plus-menu.types.ts";

it.each<ChatComposerPlusMenuView>([
  "root",
  "skills",
  "connectors",
  "tools:docs",
  "library:missing",
])(
  "retains %s menu content on unrelated publications and admits in-place display changes",
  async (view) => {
    const menu: ChatComposerPlusMenuProps = {
      attachments: {},
      disabled: false,
      open: false,
      view,
      toolOverrides: null,
      onOpenChange: (open) => {
        menu.open = open;
        setProps(snapshot());
      },
      onViewChange: vi.fn(),
      capabilityMenu: {
        basePath: "/control",
        skills: [{ key: "focused", name: "Focused skill", enabled: true, baseEnabled: true }],
        skillsLoading: false,
        skillsError: false,
        mcpServers: [
          {
            name: "docs",
            enabled: true,
            transport: "stdio",
            target: "docs-server",
            auth: null,
            signIn: null,
            toolFilter: false,
            parallel: false,
            tls: null,
          },
        ],
        toolsEffectiveResult: {
          agentId: "main",
          profile: "full",
          groups: [
            {
              id: "mcp",
              label: "MCP",
              source: "mcp",
              tools: [
                {
                  id: "docs_search",
                  label: "Search documents",
                  description: "Search",
                  rawDescription: "Search",
                  source: "mcp",
                  mcpServer: "docs",
                  mcpToolName: "search",
                },
              ],
            },
          ],
        },
        toolsEffectiveLoading: false,
        toolsEffectiveError: false,
        toolAccessMutationBlockedReason: null,
        webSearchBaseEnabled: true,
        mutationBlockedReason: null,
        canAdmin: true,
        adminBlockedReason: null,
        onLoadSkills: vi.fn(),
        onPatchToolOverrides: vi.fn(),
        onNavigate: vi.fn(),
        onOpenToolAccess: vi.fn(),
        library: {
          result: null,
          loading: false,
          busy: false,
          error: null,
          notice: "Library ready",
          canWrite: true,
          onReload: vi.fn(),
          onRead: vi.fn(),
          onActivate: vi.fn(),
        },
      },
    };
    const snapshot = () => ({ ...menu, capabilityMenu: { ...menu.capabilityMenu! } });
    const [props, setProps] = createSignal(snapshot());
    const mounted = mountSolid(() => <ChatComposerPlusMenu menu={props()} />);
    flush();
    mounted.container.querySelector<HTMLButtonElement>(".agent-chat__input-btn--attach")!.click();
    await waitForSolid(() =>
      expect(
        mounted.container
          .querySelector(".agent-chat__capability-menu-panel")
          ?.matches(":popover-open"),
      ).toBe(true),
    );
    const observer = new MutationObserver(() => {});
    observer.observe(mounted.container, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    const refresh = () => {
      setProps(snapshot());
      flush();
    };
    const content = mounted.container.querySelector(".agent-chat__capability-menu-panel")!;
    const children = [...content.querySelectorAll("*")];
    refresh();
    expect(observer.takeRecords()).toHaveLength(0);
    expect([...content.querySelectorAll("*")]).toEqual(children);

    const capability = menu.capabilityMenu!;
    switch (view) {
      case "root":
        capability.webSearchBaseEnabled = false;
        refresh();
        expect(
          content.querySelector('[data-value="toggle-web-search"]')?.getAttribute("aria-checked"),
        ).toBe("false");
        expect(
          content.querySelector('[data-value="toggle-web-search"]')?.matches(":disabled"),
        ).toBe(true);
        break;
      case "skills":
        capability.skills![0]!.name = "Renamed skill";
        capability.skills![0]!.enabled = false;
        refresh();
        expect(content.querySelector('[data-value="skill:focused"]')?.textContent).toContain(
          "Renamed skill",
        );
        expect(
          content.querySelector('[data-value="skill:focused"]')?.getAttribute("aria-checked"),
        ).toBe("false");
        break;
      case "connectors":
        capability.mcpServers[0]!.enabled = false;
        refresh();
        expect(content.querySelector('[data-value="connector:docs"]')?.textContent).toContain(
          "Disabled",
        );
        expect(
          content.querySelector('[data-value="connector:docs"]')?.getAttribute("aria-checked"),
        ).toBe("false");
        break;
      case "tools:docs":
        menu.toolOverrides = { mcpToolsDeny: { docs: ["search"] } };
        refresh();
        expect(
          content.querySelector('[data-value="mcp-tool:search"]')?.getAttribute("aria-checked"),
        ).toBe("false");
        break;
      case "library:missing":
        capability.library!.notice = "Refreshed library";
        refresh();
        expect(content.textContent).toContain("Refreshed library");
        break;
    }
  },
);
