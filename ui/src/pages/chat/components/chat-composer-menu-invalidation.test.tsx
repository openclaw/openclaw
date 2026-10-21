/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  docsServer,
  docsTools,
  makeCapabilities,
  makeMenu,
} from "./chat-composer-menu.test-support.ts";
import { ChatComposerPlusMenu } from "./chat-composer-plus-menu.tsx";
import type { ChatComposerPlusMenuProps } from "./chat-composer-plus-menu.types.ts";

it.each(["root", "skills", "connectors", "tools:docs", "library:missing"] as const)(
  "retains %s menu content on unrelated publications and admits in-place display changes",
  async (view) => {
    const skillName = vi.fn(() => "Focused skill");
    const menu: ChatComposerPlusMenuProps = makeMenu({
      view,
      onOpenChange: (open) => {
        menu.open = open;
        setProps(snapshot());
      },
      capabilityMenu: makeCapabilities({
        skills: [
          {
            key: "focused",
            get name() {
              return skillName();
            },
            set name(value: string) {
              skillName.mockImplementation(() => value);
            },
            enabled: true,
            baseEnabled: true,
          },
        ],
        mcpServers: [docsServer(true)],
        toolsEffectiveResult: docsTools(),
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
      }),
    });
    const snapshot = () => ({ ...menu, capabilityMenu: { ...menu.capabilityMenu! } });
    const [props, setProps] = createSignal(snapshot());
    const mounted = mountSolid(() => <ChatComposerPlusMenu menu={props()} />);
    flush();
    expect(skillName).not.toHaveBeenCalled();
    mounted.container.querySelector<HTMLButtonElement>(".agent-chat__input-btn--attach")!.click();
    const content = mounted.container.querySelector(".agent-chat__capability-menu-panel")!;
    await waitForSolid(() => expect(content.matches(":popover-open")).toBe(true));
    const expectedContent = {
      root: "Web search",
      skills: "Focused skill",
      connectors: "docs",
      "tools:docs": "Search documents",
      "library:missing": "Library ready",
    }[view];
    await waitForSolid(() => expect(content.textContent).toContain(expectedContent));
    const observer = new MutationObserver(() => {});
    observer.observe(mounted.container, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    const refresh = () => {
      setProps(snapshot());
      flush();
    };
    const item = (value: string) => {
      const row = content.querySelector(`[data-value="${value}"]`)!;
      return {
        checked: row.getAttribute("aria-checked"),
        disabled: row.matches(":disabled"),
        text: row.textContent,
      };
    };
    const children = [...content.querySelectorAll("*")];
    refresh();
    expect(observer.takeRecords()).toHaveLength(0);
    expect([...content.querySelectorAll("*")]).toEqual(children);

    const capability = menu.capabilityMenu!;
    switch (view) {
      case "root":
        capability.webSearchBaseEnabled = false;
        refresh();
        expect(item("toggle-web-search")).toMatchObject({ checked: "false", disabled: true });
        break;
      case "skills":
        capability.skills![0]!.name = "Renamed skill";
        capability.skills![0]!.enabled = false;
        refresh();
        expect(item("skill:focused")).toMatchObject({
          checked: "false",
          text: expect.stringContaining("Renamed skill"),
        });
        break;
      case "connectors":
        capability.mcpServers[0]!.enabled = false;
        refresh();
        expect(item("connector:docs")).toMatchObject({
          checked: "false",
          text: expect.stringContaining("Disabled"),
        });
        break;
      case "tools:docs":
        menu.toolOverrides = { mcpToolsDeny: { docs: ["search"] } };
        refresh();
        expect(item("mcp-tool:search").checked).toBe("false");
        break;
      case "library:missing":
        capability.library!.notice = "Refreshed library";
        refresh();
        expect(content.textContent).toContain("Refreshed library");
        break;
    }
  },
);
