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

it.each(["root", "skills", "connectors", "libraries", "library:missing"] as const)(
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
          error: "Library unavailable",
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
    await import("./chat-composer-plus-menu-content.tsx");
    const content = mounted.container.querySelector(".agent-chat__capability-menu-panel")!;
    await waitForSolid(() => expect(content.matches(":popover-open")).toBe(true));
    const expectedContent = {
      root: "Web search",
      skills: "Focused skill",
      connectors: "docs",
      libraries: "Library unavailable",
      "library:missing": "Library unavailable",
    }[view];
    await waitForSolid(() => expect(content.textContent).toContain(expectedContent));
    if (view === "connectors") {
      (content.querySelector('[data-value="server:docs"]') as HTMLElement).click();
      await waitForSolid(() => expect(content.textContent).toContain("Search documents"));
    }
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

    const capability = menu.capabilityMenu!.read()!;
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
      case "connectors": {
        capability.mcpServers[0]!.enabled = false;
        refresh();
        expect(
          content.querySelector('[role="switch"][aria-label="docs"]')?.getAttribute("aria-checked"),
        ).toBe("false");
        menu.toolOverrides = { mcpToolsDeny: { docs: ["search"] } };
        refresh();
        expect(item("mcp-tool:search").checked).toBe("false");
        capability.toolsEffectiveError = true;
        refresh();
        const retry = vi.fn();
        capability.onOpenToolAccess = retry;
        refresh();
        mounted.getByRole("button", { name: "Retry", hidden: true }).click();
        expect(retry).toHaveBeenCalledExactlyOnceWith("docs");
        break;
      }
      case "libraries":
      case "library:missing":
        capability.library!.error = "Refreshed library";
        refresh();
        expect(content.textContent).toContain("Refreshed library");
        break;
    }
  },
);
