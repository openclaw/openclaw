/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ControlUiBootstrapConfig,
  ControlUiEnvironment,
} from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { renderSidebarAgentCard } from "../components/app-sidebar-render.tsx";
import { AppSidebarOwner, type AppSidebarElement } from "../components/app-sidebar.tsx";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createContext, createGateway, createSessions } from "../test-helpers/app-sidebar.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { makeBootRoster } from "./bootstrap.test-support.ts";
import { createApplicationConfigCapability } from "./config.ts";
import { bindControlUiDocumentHead, controlUiDocumentHead } from "./control-ui-document-head.ts";

const root = document.documentElement;
const bootstrap = { basePath: "", assistantName: "OpenClaw", assistantAvatar: "O" };
const edge = { label: "edge", color: "amber" } as const;
function icon(href: string, type: string) {
  const link = document.createElement("link");
  Object.assign(link, { rel: "icon", href, type });
  document.head.append(link);
  return link;
}
function setupConfig(...updates: Partial<ControlUiBootstrapConfig>[]) {
  root.style.setProperty("--control-ui-environment-amber", "#f59e0b");
  const fetchMock = vi.fn<typeof fetch>();
  for (const update of updates) {
    fetchMock.mockResolvedValueOnce(Response.json({ ...bootstrap, ...update }));
  }
  vi.stubGlobal("fetch", fetchMock);
  return createApplicationConfigCapability({ resourceBasePath: "" });
}
async function refresh(config: ReturnType<typeof createApplicationConfigCapability>) {
  await config.refresh();
  await vi.dynamicImportSettled();
}
function expectStyle(property: string, value: string) {
  expect(root.style.getPropertyValue(property)).toBe(value);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  controlUiDocumentHead().favicons.forEach((link) => link.remove());
  bindControlUiDocumentHead({ themeColors: [], favicons: [] });
  root.removeAttribute("data-openclaw-environment");
  root.style.removeProperty("--control-ui-environment-color");
  root.style.removeProperty("--control-ui-environment-ink");
  root.style.removeProperty("--control-ui-environment-amber");
  root.style.removeProperty("--ring");
  root.style.removeProperty("--accent");
});

setupSidebarTest();

it("renders and clears environment presentation, including the sidebar badge and avatar ring", async () => {
  document.title = "OpenClaw Control";
  const favicon = icon("/favicon.svg", "image/svg+xml");
  const png = icon("/favicon-32.png", "image/png");
  bindControlUiDocumentHead({ themeColors: [], favicons: [favicon, png] });

  const config = setupConfig({ environment: edge, seamColor: "#123456" }, {});
  const [cardEnvironment, setCardEnvironment] = createSignal<ControlUiEnvironment | null>(null);
  const context = {
    ...createContext(
      createGateway(createTestGatewayClient(async () => ({}))),
      createSessions("main", []),
      makeBootRoster({ agents: [{ id: "main", name: "OpenClaw" }] }),
    ),
    get config() {
      cardEnvironment();
      return config;
    },
  };
  const sidebarProps = document.createElement("openclaw-app-sidebar") as AppSidebarElement;
  sidebarProps.sidebarAgentsMode = "chip";
  const host = new AppSidebarOwner(
    { dashboards: null, loadMoreDashboards() {} },
    context,
    sidebarProps,
  );
  const { container: sidebar } = mountSolid(() => renderSidebarAgentCard(host));
  expect(document.querySelector(".control-ui-environment-stripe")).toBeNull();
  expect(document.querySelector(".control-ui-environment-pill")).toBeNull();
  expect(favicon.getAttribute("href")).toBe("/favicon.svg");

  await refresh(config);
  setCardEnvironment(config.current.environment);

  expect(document.querySelector(".control-ui-environment-stripe")).not.toBeNull();
  expectStyle("--control-ui-environment-color", "var(--control-ui-environment-amber)");
  expectStyle("--ring", "#123456");
  await waitForSolid(() =>
    expect(sidebar.querySelector(".control-ui-environment-pill")?.textContent).toBe("edge"),
  );
  expect(sidebar.querySelector(".sidebar-agent-card__avatar--environment")).not.toBeNull();
  expect(favicon.href).toContain("data:image/svg+xml,");
  expect(decodeURIComponent(favicon.href)).toContain("#f59e0b");
  expect(png.type).toBe("image/svg+xml");
  expect(document.title).toBe("OpenClaw Control · edge");
  expect(root.hasAttribute("data-openclaw-environment")).toBe(true);

  await refresh(config);
  expect(config.current.environment).toBeNull();
  expect(document.querySelector(".control-ui-environment-stripe")).toBeNull();
  expect([favicon, png].map((link) => [link.getAttribute("href"), link.type])).toEqual([
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon-32.png", "image/png"],
  ]);
  expectStyle("--control-ui-environment-color", "");
  expectStyle("--control-ui-environment-ink", "");
  expect(document.title).toBe("OpenClaw Control");
  expect(root.hasAttribute("data-openclaw-environment")).toBe(false);
});

it("clears seam-only presentation when bootstrap becomes unset", async () => {
  const config = setupConfig({ seamColor: "#123456" }, {});
  await refresh(config);
  expectStyle("--ring", "#123456");
  expectStyle("--accent", "#123456");
  await refresh(config);
  expectStyle("--ring", "");
  expectStyle("--accent", "");
});

it("applies public document environment metadata before authenticated bootstrap", async () => {
  root.setAttribute("data-openclaw-environment", JSON.stringify({ label: "team", color: "amber" }));
  document.title = "OpenClaw Control";

  const config = createApplicationConfigCapability({ resourceBasePath: "" });
  await vi.dynamicImportSettled();

  expect(config.current.environment).toEqual({ label: "team", color: "amber" });
  expect(document.querySelector(".control-ui-environment-stripe")).not.toBeNull();
  expect(document.title).toBe("OpenClaw Control · team");
});
