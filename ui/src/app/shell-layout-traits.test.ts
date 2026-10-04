import { html, LitElement, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ShellLayoutController,
  shellLayoutTraits,
  type ShellLayoutTraits,
} from "./shell-layout-traits.ts";

class LayoutPage extends LitElement {
  traits: ShellLayoutTraits = {};
  showPrimary = true;
  showHeader = false;
  removeAfterRender = false;
  inspectPrimary: (element: Element | undefined) => void = () => {};

  protected override createRenderRoot() {
    return this;
  }

  protected override render() {
    return html`
      ${this.showPrimary ? html`<section ${shellLayoutTraits(this.traits)} ${ref(this.inspectPrimary)}>Page</section>` : nothing}
      ${this.showHeader ? html`<header ${shellLayoutTraits({ hubHeader: true })}>Hub</header>` : nothing}
    `;
  }

  protected override updated() {
    if (this.removeAfterRender) {
      this.removeAfterRender = false;
      this.remove();
    }
  }
}

class LayoutShell extends LitElement {
  private readonly layout = new ShellLayoutController(this);

  protected override createRenderRoot() {
    return this;
  }

  protected override render() {
    return html`
      <main class="content ${this.layout.className}" ${ref(this.layout.contentRef)}></main>
      <aside></aside>
    `;
  }
}

const pageTag = `test-shell-layout-page-${crypto.randomUUID()}`;
const shellTag = `test-shell-layout-host-${crypto.randomUUID()}`;
customElements.define(pageTag, LayoutPage);
customElements.define(shellTag, LayoutShell);

async function mountShell() {
  const shell = new LayoutShell();
  document.body.append(shell);
  await shell.updateComplete;
  const content = shell.querySelector("main");
  const dock = shell.querySelector("aside");
  if (!content || !dock) {
    throw new Error("Layout fixture did not render its content and dock");
  }
  return {
    shell,
    content,
    dock,
  };
}

function createPage(traits: ShellLayoutTraits) {
  const page = new LayoutPage();
  page.traits = traits;
  return page;
}

async function updatePage(page: LayoutPage, shell: LayoutShell) {
  page.requestUpdate();
  await page.updateComplete;
  await shell.updateComplete;
}

function activeLayout(content: HTMLElement) {
  return (
    [
      ["embed", "content--plugin-embed"],
      ["hub", "content--hub-header"],
      ["toolbar", "content--toolbar-header"],
      ["workbench", "content--workbench"],
    ] as const
  )
    .filter(([, className]) => content.classList.contains(className))
    .map(([name]) => name);
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("shell layout publication", () => {
  it("aggregates retained pages and removes only the departing marker's facts", async () => {
    const { shell, content } = await mountShell();
    const page = createPage({ pluginEmbed: true, toolbarHeader: true });
    page.showHeader = true;
    const retained = createPage({ pluginEmbed: true, workbench: true });
    retained.hidden = true;
    content.append(page, retained);
    await Promise.all([page.updateComplete, retained.updateComplete]);
    await shell.updateComplete;
    expect(activeLayout(content)).toEqual(["embed", "hub", "toolbar", "workbench"]);

    page.showPrimary = false;
    await updatePage(page, shell);
    expect(activeLayout(content)).toEqual(["embed", "hub", "workbench"]);
    expect(retained.hidden).toBe(true);
    expect(retained.isConnected).toBe(true);

    retained.remove();
    await shell.updateComplete;
    expect(activeLayout(content)).toEqual(["hub"]);

    page.showHeader = false;
    await updatePage(page, shell);
    expect(activeLayout(content)).toEqual([]);
  });

  it("does not publish or update the shell again for unchanged rendered facts", async () => {
    const { shell, content } = await mountShell();
    const page = createPage({ pluginEmbed: true });
    content.append(page);
    await updatePage(page, shell);
    const shellUpdate = vi.spyOn(shell, "requestUpdate");

    page.traits = { pluginEmbed: true, toolbarHeader: false };
    await updatePage(page, shell);
    expect(shellUpdate).not.toHaveBeenCalled();
    expect(activeLayout(content)).toEqual(["embed"]);

    page.traits = { toolbarHeader: true };
    await updatePage(page, shell);
    expect(shellUpdate).toHaveBeenCalledOnce();
    expect(activeLayout(content)).toEqual(["toolbar"]);
  });

  it.each([false, true])(
    "publishes before measurement and retires/reconnects a page (self-removal: %s)",
    async (selfRemoval) => {
      const { shell, content } = await mountShell();
      const style = document.createElement("style");
      style.textContent = ".content--plugin-embed { padding-left: 16px; }";
      shell.append(style);
      const page = createPage({ pluginEmbed: true });
      page.removeAfterRender = selfRemoval;
      const observations: { connected: boolean; padding: string }[] = [];
      page.inspectPrimary = (element) => {
        if (element) {
          observations.push({
            connected: element.isConnected,
            padding: getComputedStyle(content).paddingLeft,
          });
        }
      };
      content.append(page);
      await page.updateComplete;
      expect(observations).toEqual([{ connected: false, padding: "16px" }]);
      expect(page.querySelector("section")).not.toBeNull();
      if (!selfRemoval) {
        expect(activeLayout(content)).toEqual(["embed"]);
        page.remove();
      }
      expect(page.isConnected).toBe(false);
      expect(activeLayout(content)).toEqual([]);
      await shell.updateComplete;
      expect(activeLayout(content)).toEqual([]);
      content.append(page);
      expect(activeLayout(content)).toEqual(["embed"]);
      await shell.updateComplete;
      expect(activeLayout(content)).toEqual(["embed"]);
    },
  );

  it("keeps sibling dock facts out of content, including a page moved out of content", async () => {
    const { shell, content, dock } = await mountShell();
    const page = createPage({ pluginEmbed: true });
    const dockPage = createPage({ workbench: true });
    content.append(page);
    dock.append(dockPage);
    await Promise.all([page.updateComplete, dockPage.updateComplete]);
    await shell.updateComplete;
    expect(activeLayout(content)).toEqual(["embed"]);

    dock.append(page);
    await Promise.resolve();
    await shell.updateComplete;
    expect(activeLayout(content)).toEqual([]);

    page.traits = { toolbarHeader: true };
    await updatePage(page, shell);
    expect(activeLayout(content)).toEqual([]);

    content.append(page);
    expect(activeLayout(content)).toEqual(["toolbar"]);
  });
});
