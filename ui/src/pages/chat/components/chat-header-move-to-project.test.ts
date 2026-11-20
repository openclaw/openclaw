/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { expect, it, vi } from "vitest";
import type { GatewayRequestHandler } from "../../../test-helpers/gateway-client.ts";
import {
  gatewayHelloForMethods,
  SESSION_MUTATION_TEST_METHODS,
} from "../../../test-helpers/gateway-methods.ts";
import { installDialogPolyfill } from "../../../test-helpers/modal-dialog.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createGatewayBrowserClientFixture } from "../chat-application-context.test-support.ts";
import { createPaneHeaderWorkspaceFixture, createTestChatPane } from "../chat-pane.test-support.ts";
import type { ChatPageHost } from "../chat-state-host.ts";
import {
  chatPaneHeaderSessionRow as row,
  openNativeMenu,
  renderPaneHeaderInto,
  selectNativeMenu,
} from "./chat-pane-header.test-support.ts";
import "./chat-header-session-menu.ts";

function renderMenu(request: GatewayRequestHandler) {
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture({
      request: (method, params) =>
        method === "sessions.list" ? { sessions: [] } : request(method, params),
    }),
  });
  state.settings = {} as ChatPageHost["settings"];
  pane.applyGatewaySnapshot({
    ...pane.context.gateway.snapshot,
    hello: gatewayHelloForMethods([
      ...SESSION_MUTATION_TEST_METHODS,
      "projects.list",
      "projects.moveSession",
    ]),
  });
  const container = document.body.appendChild(document.createElement("div"));
  const header = pane.renderPaneHeader(
    createPaneHeaderWorkspaceFixture(state),
    row({ key: "agent:main:current" }),
    false,
    undefined,
    false,
    null,
  );
  renderPaneHeaderInto(header, container);
  return expectDefined(container.querySelector("openclaw-chat-header-session-menu"), "menu");
}

const projects = [
  { id: "project-1", name: "Website", checkouts: [] },
  {
    id: "project-2",
    name: "Billing",
    checkouts: [{ path: "billing", commit: "eac9b90e94b1".padEnd(40, "0"), unsavedFiles: 2 }],
  },
];

it("omits Move when the catalog contains only the agent workspace", async () => {
  const request = vi.fn<GatewayRequestHandler>(async () => ({
    projects: [{ id: "workspace:main", source: "workspace" }],
  }));
  const menu = renderMenu(request);
  await openNativeMenu(menu, "submenu:view");
  expect(request).toHaveBeenCalledWith("projects.list", {});
  expect(menu.querySelector('button[data-value="quick:move-to-project"]')).toBeNull();
});

it("moves into the existing project selected in the dropdown with its detected checkout", async () => {
  installDialogPolyfill();
  const request = vi.fn<GatewayRequestHandler>(async (method) => {
    if (method === "projects.list") {
      return {
        projects: projects.map(({ id, name }) => ({ id, displayName: name, source: "registered" })),
      };
    }
    if (method === "projects.moveSessionOptions") {
      return { available: true, projects };
    }
    return method === "projects.moveSession" ? { status: "pending", projectId: "project-2" } : {};
  });
  const menu = renderMenu(request);
  await selectNativeMenu(menu, "quick:move-to-project");

  const picker = await waitForSolid(() =>
    expectDefined(
      document.body.querySelector<HTMLButtonElement>(
        '.move-to-project-dialog [aria-haspopup="listbox"]',
      ),
      "project dropdown",
    ),
  );
  picker.click();
  const options = await waitForSolid(() => {
    const choices = [
      ...document.querySelectorAll<HTMLElement>('.move-to-project-dialog [role="option"]'),
    ];
    expect(choices.map((choice) => choice.textContent?.trim())).toEqual(["Website", "Billing"]);
    return choices;
  });
  options[1]!.click();
  flush();
  expect(document.body.textContent).toContain(
    "Carry work from billing at commit eac9b90e94b1. Files with unsaved changes: 2.",
  );
  expectDefined(
    document.body.querySelector<HTMLFormElement>("openclaw-modal-dialog form"),
    "dialog form",
  ).requestSubmit();

  await waitForSolid(() =>
    expect(request.mock.calls.find(([method]) => method === "projects.moveSession")?.[1]).toEqual({
      sessionKey: "agent:main:current",
      projectId: "project-2",
      checkout: "billing",
    }),
  );
});
