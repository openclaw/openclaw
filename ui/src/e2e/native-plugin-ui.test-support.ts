import { writeFileSync } from "node:fs";
import path from "node:path";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";

function traceNativeWorkspaceLitErrors() {
  const scope = window as NativePluginWindow;
  const trace = { errors: [] as unknown[] };
  scope.nativeWorkspaceLitTrace = trace;
  const prototypes = new WeakSet<object>();
  const discover = (node: Node) => {
    if (!(node instanceof Comment) || node.data !== "lit-content") {
      return;
    }
    const cached: unknown = Reflect.get(node, "_$litPart$");
    if (!cached || typeof cached !== "object") {
      return;
    }
    // Lit's DEV runtime caches the RootPart on this renderBefore comment.
    const prototype: object = Object.getPrototypeOf(cached);
    const original: unknown = Reflect.get(prototype, "_$setValue");
    // The bundled production runtime renames this method; this probe targets Lit DEV.
    if (prototypes.has(prototype) || typeof original !== "function") {
      return;
    }
    prototypes.add(prototype);
    Reflect.set(prototype, "_$setValue", function (this: object, ...args: unknown[]) {
      try {
        return Reflect.apply(original, this, args);
      } catch (error) {
        if (trace.errors.length < 3) {
          trace.errors.push({
            message: error instanceof Error ? error.message.slice(0, 1_600) : "Non-Error throw",
            stack: error instanceof Error ? error.stack?.slice(0, 1_600) : undefined,
          });
        }
        throw error;
      }
    });
  };
  const scan = (node: Node) => {
    discover(node);
    const comments = document.createTreeWalker(node, NodeFilter.SHOW_COMMENT);
    for (let comment = comments.nextNode(); comment; comment = comments.nextNode()) {
      discover(comment);
    }
  };
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
        scan(node);
      }
    }
  });
  // The auth:none fixture's withPage context owns this observer and patched realm.
  observer.observe(document, { childList: true, subtree: true });
  scan(document);
}

export async function installNativeWorkspaceLitErrorTrace(page: Page): Promise<void> {
  await page.addInitScript({
    content: `;(() => { const __name = (target) => target; (${traceNativeWorkspaceLitErrors.toString()})(); })();`,
  });
}

/** Supplement the suite's DOM/screenshot diagnostics with plugin ownership. */
export async function captureNativeWorkspaceFailure(page: Page): Promise<void> {
  const readBrowserState = page.evaluate(() => {
    const hosts = [...document.querySelectorAll("openclaw-plugin-view")];
    const app = document.querySelector("openclaw-app");
    const target =
      hosts.find((host) => host.surface === "workspace") ??
      document.querySelector("openclaw-app-shell") ??
      app?.firstElementChild;
    let owner: unknown = null;
    target?.dispatchEvent(
      Object.assign(new Event("context-request", { bubbles: true, composed: true }), {
        context: "openclaw.application",
        contextTarget: target,
        subscribe: false,
        callback(context: ApplicationContext) {
          owner = {
            registryStatus: context.plugins.registryStatus,
            selected: (["workspace", "composer", "transcript"] as const).map((surface) => {
              const selected = context.plugins.selectedReplacement(surface);
              return {
                surface,
                key: selected?.key ?? null,
                aborted: selected?.signal.aborted ?? null,
              };
            }),
            errorCount: context.plugins.errors.length,
          };
        },
      }),
    );
    return {
      owner,
      bridgeRegistered: Boolean(customElements.get("openclaw-plugin-view")),
      hosts: hosts.map((host) => ({
        kind: host.kind,
        surface: host.surface,
        presented: host.presented,
        connected: host.isConnected,
        rect: host.getBoundingClientRect().toJSON(),
        display: getComputedStyle(host).display,
        visibility: getComputedStyle(host).visibility,
        roots: host.querySelectorAll("[data-plugin-view-root]").length,
      })),
      litErrors: (window as NativePluginWindow).nativeWorkspaceLitTrace ?? null,
    };
  });
  const observation = await withTimeout(readBrowserState, 5_000, "native workspace diagnostics");
  const directory = createControlUiE2eArtifactDir(
    "failure",
    process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR?.trim() || undefined,
  );
  writeFileSync(
    path.join(directory, "failure.public.json"),
    `${JSON.stringify({ schemaVersion: 1, nativeWorkspace: observation }, null, 2)}\n`,
  );
}

export async function captureNativePluginUiProof(
  owner: { readonly artifactDir: string },
  page: Page,
  name: string,
  options: { fullPage?: boolean } = {},
): Promise<void> {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
    await page.screenshot({ ...options, path: path.join(owner.artifactDir, name) });
  }
}

export type NativePluginWindow = Window & {
  nativeWorkspaceLitTrace?: { errors: unknown[] };
  nativePluginProof?: { release?: () => void };
  nativeActionProof?: {
    runs: number;
    current?: {
      signal: AbortSignal;
      release: () => void;
      withdraw: () => void;
      done: boolean;
      outcome: string;
    };
  };
};

export async function waitForPendingPluginInitializer(page: Page): Promise<void> {
  // Request capture precedes its reply and the initializer's awaited continuation.
  await page.waitForFunction(
    () => typeof (window as NativePluginWindow).nativePluginProof?.release === "function",
  );
}

export const pluginId = "ui-fixture";

export function catalog(revision: string) {
  const plugin = {
    pluginId,
    name: "UI fixture",
    revision,
    entryUrl: `/__openclaw__/plugins/control-ui/${pluginId}/${revision}/index.js`,
    styles: [],
  };
  return { revision, diagnostics: [], plugins: [plugin] };
}

export function pluginModule(revision: string, replacements = true) {
  return `export default {
    id: "ui-fixture",
    async activate(host) {
      const proof = globalThis.nativePluginProof ??= {};
      const previous = proof.host;
      if (${JSON.stringify(revision)} === "broken") throw new Error("Fixture activation failed");
      if (${JSON.stringify(revision)} === "pending") {
        await host.request("fixture.activationStarted");
        await new Promise(resolve => { proof.release = resolve; });
        await host.request("fixture.staleInitializer");
      }
      proof.host = host;
      host.ui.registerPage({id:"proof", label:"UI fixture", mount(container, context) {
        const title = document.createElement("h1"); title.textContent = "Fixture revision ${revision}";
        const output = document.createElement("output"); output.setAttribute("aria-label", "Fixture outcome");
        const button = (label, action) => { const element = document.createElement("button"); element.textContent = label; element.onclick = async () => { try { await action(); output.textContent = "completed"; } catch(error) { output.textContent = error.message; } }; return element; };
        container.append(title, output,
          button("Call current activation", () => context.host.request("fixture.current")),
          button("Unregister composer", () => unregisterComposer()),
          button("Register composer", () => { unregisterComposer = registerComposer(); }),
          button("Unregister retired composer", () => firstUnregisterComposer()),
          button("Call retired composer", () => proof.composer.setDraft("retired draft")),
          button("Call previous activation", () => previous.request("fixture.stale")),
          button("Release pending initializer", () => { proof.release(); throw new Error("released"); }));
      }});
      host.ui.registerNavigation({id:"proof", label:"UI fixture", page:{id:"proof"}});
      host.ui.registerAccessory({id:"session", placement:"session-header", mount(container, context) {
        const output = document.createElement("output"); output.dataset.fixtureSessionAccessory = "";
        const update = next => { output.textContent = next.props.sessionKey; output.dataset.presented = String(next.presented); output.hidden = !next.presented; };
        container.append(output); update(context);
        return { update };
      }});
      host.ui.registerWidget({id:"card", label:"Fixture widget", mount(container) {
        const content = document.createElement("p"); content.textContent = "Fixture widget ${revision}";
        container.append(content);
      }});
      if (!${replacements}) return;
      const composer = {id:"composer", label:"Fixture composer", surface:"composer", mount(container, context) {
        let current = context;
        proof.composer = context.props;
        const input = document.createElement("textarea"); input.setAttribute("aria-label", "Fixture draft"); input.value = current.props.draft;
        input.oninput = () => current.props.setDraft(input.value);
        const send = document.createElement("button"); send.textContent = "Fixture send";
        const output = document.createElement("output"); output.setAttribute("aria-label", "Send outcome");
        send.onclick = async () => { try { const result = await current.props.send(); output.textContent = result === true ? "accepted" : result === false ? "rejected" : "completed"; } catch(error) { output.textContent = error.message; } };
        container.append(input, send, output);
        return { update(next) { current = next; input.value = next.props.draft; }, focus() { input.focus(); } };
      }};
      const registerComposer = () => host.ui.registerReplacement(composer);
      let unregisterComposer = registerComposer();
      const firstUnregisterComposer = unregisterComposer;
      host.ui.registerReplacement({id:"delegated-composer", label:"Delegated composer", surface:"composer", mount(container, context) {
        return {dispose: context.mountDefault(container)};
      }});
      host.ui.registerReplacement({id:"failing-composer", label:"Failing composer", surface:"composer", mount() { throw new Error("Fixture composer failed"); }});
      host.ui.registerReplacement({id:"workspace", label:"Fixture workspace", surface:"workspace", mount(container, context) {
        const title = document.createElement("h1"); title.textContent = "Custom workspace";
        const recover = document.createElement("button"); recover.textContent = "Show built-in workspace";
        recover.onclick = () => context.host.ui.selectReplacement("workspace", null);
        container.append(title, recover);
      }});
      host.ui.registerReplacement({id:"default-workspace", label:"Default-backed workspace", surface:"workspace", mount(container, context) {
        return {dispose: context.mountDefault(container)};
      }});
      host.ui.registerReplacement({id:"failing-transcript", label:"Failing transcript", surface:"transcript", mount() { throw new Error("Fixture transcript failed"); }});
      if (["withdrawn", "invalid-selection"].includes(${JSON.stringify(revision)})) {
        if (${JSON.stringify(revision)} === "invalid-selection") {
          host.ui.selectReplacement("workspace", "workspace");
        }
        const replacement = {id:"staged-composer", label:"Staged composer", surface:"composer", mount() {}};
        const withdraw = host.ui.registerReplacement(replacement);
        host.ui.selectReplacement("composer", replacement.id);
        if (${JSON.stringify(revision)} === "withdrawn") withdraw();
        else replacement.surface = "transcript";
      }
      return () => { proof.disposed = (proof.disposed ?? 0) + 1; };
    }
  };`;
}

export async function expectComposerFooterLayout(page: Page, composer: Locator, variant: string) {
  for (const width of [1280, 640]) {
    await page.setViewportSize({ width, height: 900 });
    // TranscriptLayoutOwner commits the scrollport size in ResizeObserver,
    // after the browser viewport changes. Measure only that committed layout.
    await expect
      .poll(() =>
        composer.evaluate((element) => {
          const thread = element.closest(".chat-main__conversation")?.querySelector(".chat-thread");
          const slot = thread?.parentElement;
          return (
            thread instanceof HTMLElement &&
            Boolean(slot) &&
            thread.offsetWidth === slot?.offsetWidth &&
            thread.offsetHeight === slot?.offsetHeight
          );
        }),
      )
      .toBe(true);
    const geometry = await composer.evaluate((element) => {
      const footer = element.closest(".chat-footer");
      const thread = element.closest(".chat-main__conversation")?.querySelector(".chat-thread");
      if (!thread || !footer) {
        throw new Error("Expected the composer in the footer beside the transcript.");
      }
      const shellBounds = element.getBoundingClientRect();
      const footerBounds = footer.getBoundingClientRect();
      const threadBounds = thread.getBoundingClientRect();
      const style = getComputedStyle(footer, "::before");
      const input = element.querySelector(".agent-chat__input");
      return {
        inputOutsideContext: Boolean(input) && !input?.closest(".chat-footer__context"),
        composerTop: shellBounds.top,
        composerBottom: shellBounds.bottom,
        footerTop: footerBounds.top,
        footerBottom: footerBounds.bottom,
        transcriptBottom: threadBounds.bottom,
        content: style.content,
        background: style.backgroundImage,
      };
    });
    const description = `${variant} at ${width}px`;
    expect.soft(geometry.transcriptBottom, description).toBeLessThanOrEqual(geometry.footerTop);
    expect.soft(geometry.composerTop, description).toBeGreaterThanOrEqual(geometry.footerTop);
    expect.soft(geometry.composerBottom, description).toBeLessThanOrEqual(geometry.footerBottom);
    expect.soft(geometry.inputOutsideContext, description).toBe(true);
    expect.soft(geometry.content, description).toBe("none");
    expect.soft(geometry.background, description).toBe("none");
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}
