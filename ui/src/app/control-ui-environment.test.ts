/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import type { ControlUiBootstrapConfig } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createApplicationConfigCapability } from "./config.ts";
import * as documentHead from "./control-ui-document-head.ts";

const root = document.documentElement;
const bootstrap = { basePath: "", assistantName: "OpenClaw", assistantAvatar: "O" };
const edge = { label: "edge", color: "amber" } as const;
function icon(href: string, type: string) {
  const link = document.head.appendChild(document.createElement("link"));
  link.id = type === "image/svg+xml" ? "openclaw-favicon-svg" : "openclaw-favicon-png";
  Object.assign(link, { rel: "icon", href, type });
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
  documentHead.controlUiDocumentHead().favicons.forEach((link) => link.remove());
  documentHead.initializeControlUiDocumentHead();
  root.removeAttribute("data-openclaw-environment");
  root.style.removeProperty("--control-ui-environment-color");
  root.style.removeProperty("--control-ui-environment-ink");
  root.style.removeProperty("--control-ui-environment-amber");
  root.style.removeProperty("--ring");
  root.style.removeProperty("--accent");
});

// The sidebar label and avatar ring live in the agent-row sidebar cases.
it("renders and clears environment presentation", async () => {
  document.title = "OpenClaw Control";
  const favicon = icon("/favicon.svg", "image/svg+xml");
  const png = icon("/favicon-32.png", "image/png");
  documentHead.initializeControlUiDocumentHead();

  const config = setupConfig({ environment: edge, seamColor: "#123456" }, {});
  expect(document.querySelector(".control-ui-environment-stripe")).toBeNull();
  expect(favicon.getAttribute("href")).toBe("/favicon.svg");

  await refresh(config);

  expect(document.querySelector(".control-ui-environment-stripe")).not.toBeNull();
  expectStyle("--control-ui-environment-color", "var(--control-ui-environment-amber)");
  expectStyle("--ring", "#ffffff");
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
  expectStyle("--ring", "#ffffff");
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
