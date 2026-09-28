import { html, LitElement, nothing } from "lit";
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

  protected override createRenderRoot() {
    return this;
  }

  protected override render() {
    return html`
      ${this.showPrimary ? html`<section ${shellLayoutTraits(this.traits)}>Page</section>` : nothing}
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
    const traits = this.layout.current;
    return html`
      <main
        @openclaw-shell-layout=${this.layout.handleChange}
        ?data-embed=${traits.pluginEmbed}
        ?data-hub=${traits.hubHeader}
        ?data-toolbar=${traits.toolbarHeader}
        ?data-workbench=${traits.workbench}
      ></main>
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
  return ["embed", "hub", "toolbar", "workbench"].filter((name) =>
    content.hasAttribute(`data-${name}`),
  );
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

  it("updates the shell when a page detaches and republishes when that page reconnects", async () => {
    const { shell, content } = await mountShell();
    const page = createPage({ pluginEmbed: true });
    content.append(page);
    await updatePage(page, shell);
    expect(activeLayout(content)).toEqual(["embed"]);

    page.remove();
    // No shell navigation or requestUpdate: the detached page must retire its facts.
    await shell.updateComplete;
    expect(activeLayout(content)).toEqual([]);

    content.append(page);
    await Promise.resolve();
    await shell.updateComplete;
    expect(activeLayout(content)).toEqual(["embed"]);
  });

  it("does not publish or update the shell again for unchanged rendered facts", async () => {
    const { shell, content } = await mountShell();
    const page = createPage({ pluginEmbed: true });
    content.append(page);
    await updatePage(page, shell);
    const published = vi.fn();
    shell.addEventListener("openclaw-shell-layout", published);
    const shellUpdate = vi.spyOn(shell, "requestUpdate");

    page.traits = { pluginEmbed: true, toolbarHeader: false };
    await updatePage(page, shell);
    expect(published).not.toHaveBeenCalled();
    expect(shellUpdate).not.toHaveBeenCalled();
    expect(activeLayout(content)).toEqual(["embed"]);

    page.traits = { toolbarHeader: true };
    await updatePage(page, shell);
    expect(published).toHaveBeenCalledOnce();
    expect(shellUpdate).toHaveBeenCalledOnce();
    expect(activeLayout(content)).toEqual(["toolbar"]);
  });

  it("fences a page removed between its first render and its queued publication", async () => {
    const { shell, content } = await mountShell();
    const page = createPage({ pluginEmbed: true });
    const published = vi.fn();
    page.addEventListener("openclaw-shell-layout", published);
    page.removeAfterRender = true;
    content.append(page);
    await page.updateComplete;
    expect(page.querySelector("section")).not.toBeNull();
    expect(page.isConnected).toBe(false);

    await Promise.resolve();
    await shell.updateComplete;
    expect(published).not.toHaveBeenCalled();
    expect(activeLayout(content)).toEqual([]);

    content.append(page);
    await Promise.resolve();
    await shell.updateComplete;
    expect(published).toHaveBeenCalledOnce();
    expect(activeLayout(content)).toEqual(["embed"]);
  });

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
  });
});
