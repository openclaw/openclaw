/* @vitest-environment jsdom */

import { createComponent, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ControlUiBootstrapConfig,
  ControlUiEnvironment,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import "../components/app-topbar-solid.tsx";
import { SidebarAgentCard } from "../components/sidebar-agent-card.tsx";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { createApplicationConfigCapability } from "./config.ts";

type EnvironmentElement = HTMLElement & {
  environment?: ControlUiEnvironment | null;
  updateComplete: Promise<boolean>;
};

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.head.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove());
  document.documentElement.removeAttribute("data-openclaw-environment");
  document.documentElement.style.removeProperty("--control-ui-environment-color");
  document.documentElement.style.removeProperty("--control-ui-environment-ink");
  document.documentElement.style.removeProperty("--control-ui-environment-amber");
  document.documentElement.style.removeProperty("--ring");
  document.documentElement.style.removeProperty("--accent");
});

describe("Control UI environment presentation", () => {
  setupSidebarTest();

  it("renders a matching stripe, favicon, avatar ring, and sidebar/topbar pills only when configured", async () => {
    const favicon = document.createElement("link");
    favicon.rel = "icon";
    favicon.type = "image/svg+xml";
    favicon.href = "/favicon.svg";
    document.head.append(favicon);
    document.documentElement.style.setProperty("--control-ui-environment-amber", "#f59e0b");

    const [cardEnvironment, setCardEnvironment] = createSignal<ControlUiEnvironment | null>(null);
    const { container: sidebar } = mountSolid(() =>
      createComponent(SidebarAgentCard, {
        agentId: "main",
        agentName: "OpenClaw",
        avatarUrl: null,
        avatarAuthReady: false,
        avatarText: "O",
        menuOpen: false,
        menuUnread: false,
        switcherAvailable: false,
        get environment() {
          return cardEnvironment();
        },
      }),
    );
    const topbar = document.createElement("openclaw-app-topbar") as EnvironmentElement;
    document.body.append(topbar);
    await topbar.updateComplete;

    expect(document.querySelector(".control-ui-environment-stripe")).toBeNull();
    expect(document.querySelector(".control-ui-environment-pill")).toBeNull();
    expect(favicon.getAttribute("href")).toBe("/favicon.svg");

    const environment = { label: "edge", color: "amber" } as const;
    const payload: ControlUiBootstrapConfig = {
      basePath: "",
      assistantName: "OpenClaw",
      assistantAvatar: "O",
      environment,
      seamColor: "#123456",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(payload))),
    );
    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    await config.refresh();
    await vi.dynamicImportSettled();
    setCardEnvironment(config.current.environment);
    topbar.environment = config.current.environment;
    await topbar.updateComplete;

    expect(document.querySelector(".control-ui-environment-stripe")).not.toBeNull();
    expect(document.documentElement.style.getPropertyValue("--control-ui-environment-color")).toBe(
      "var(--control-ui-environment-amber)",
    );
    expect(document.documentElement.style.getPropertyValue("--ring")).toBe("#123456");
    await waitForSolid(() =>
      expect(sidebar.querySelector(".control-ui-environment-pill")?.textContent).toBe("edge"),
    );
    expect(sidebar.querySelector(".sidebar-agent-card__avatar--environment")).not.toBeNull();
    expect(topbar.querySelector(".control-ui-environment-pill")?.textContent).toBe("edge");
    expect(favicon.href).toContain("data:image/svg+xml,");
    expect(decodeURIComponent(favicon.href)).toContain("#f59e0b");
  });

  it("clears environment presentation when a configured bootstrap refresh becomes unset", async () => {
    document.title = "OpenClaw Control";
    document.documentElement.style.setProperty("--control-ui-environment-amber", "#f59e0b");

    const svgFavicon = document.createElement("link");
    svgFavicon.rel = "icon";
    svgFavicon.setAttribute("href", "/favicon.svg");
    svgFavicon.setAttribute("type", "image/svg+xml");
    const pngFavicon = document.createElement("link");
    pngFavicon.rel = "icon";
    pngFavicon.setAttribute("href", "/favicon-32.png");
    pngFavicon.setAttribute("type", "image/png");
    document.head.append(svgFavicon, pngFavicon);

    const bootstrap: ControlUiBootstrapConfig = {
      basePath: "",
      assistantName: "OpenClaw",
      assistantAvatar: "O",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ...bootstrap, environment: { label: "edge", color: "amber" } }),
          ),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify(bootstrap))),
    );
    const config = createApplicationConfigCapability({ resourceBasePath: "" });

    await config.refresh();
    await vi.dynamicImportSettled();

    expect(document.querySelector(".control-ui-environment-stripe")).not.toBeNull();
    expect(svgFavicon.getAttribute("href")).toContain("data:image/svg+xml,");
    expect(pngFavicon.getAttribute("type")).toBe("image/svg+xml");
    expect(document.title).toBe("OpenClaw Control · edge");
    expect(document.documentElement.hasAttribute("data-openclaw-environment")).toBe(true);

    await config.refresh();
    await vi.dynamicImportSettled();

    expect(config.current.environment).toBeNull();
    expect(document.querySelector(".control-ui-environment-stripe")).toBeNull();
    expect(svgFavicon.getAttribute("href")).toBe("/favicon.svg");
    expect(svgFavicon.getAttribute("type")).toBe("image/svg+xml");
    expect(pngFavicon.getAttribute("href")).toBe("/favicon-32.png");
    expect(pngFavicon.getAttribute("type")).toBe("image/png");
    expect(document.documentElement.style.getPropertyValue("--control-ui-environment-color")).toBe(
      "",
    );
    expect(document.documentElement.style.getPropertyValue("--control-ui-environment-ink")).toBe(
      "",
    );
    expect(document.title).toBe("OpenClaw Control");
    expect(document.documentElement.hasAttribute("data-openclaw-environment")).toBe(false);
  });

  it("clears seam-color presentation when a seam-only bootstrap refresh becomes unset", async () => {
    const bootstrap: ControlUiBootstrapConfig = {
      basePath: "",
      assistantName: "OpenClaw",
      assistantAvatar: "O",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify({ ...bootstrap, seamColor: "#123456" })))
        .mockResolvedValueOnce(new Response(JSON.stringify(bootstrap))),
    );
    const config = createApplicationConfigCapability({ resourceBasePath: "" });

    await config.refresh();
    await vi.dynamicImportSettled();

    expect(document.documentElement.style.getPropertyValue("--ring")).toBe("#123456");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");

    await config.refresh();
    await vi.dynamicImportSettled();

    for (const property of [
      "--ring",
      "--accent",
      "--accent-hover",
      "--accent-muted",
      "--accent-subtle",
      "--accent-glow",
      "--primary",
      "--focus",
      "--focus-ring",
      "--focus-glow",
    ]) {
      expect(document.documentElement.style.getPropertyValue(property)).toBe("");
    }
  });

  it("applies public document environment metadata before authenticated bootstrap", async () => {
    document.documentElement.setAttribute(
      "data-openclaw-environment",
      JSON.stringify({ label: "team", color: "amber" }),
    );
    document.title = "OpenClaw Control";

    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    await vi.dynamicImportSettled();

    expect(config.current.environment).toEqual({ label: "team", color: "amber" });
    expect(document.querySelector(".control-ui-environment-stripe")).not.toBeNull();
    expect(document.title).toBe("OpenClaw Control · team");
  });
});
