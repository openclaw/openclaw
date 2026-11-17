/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
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
  renderPaneHeaderInto,
} from "./chat-pane-header.test-support.ts";
import "./chat-header-session-menu.ts";

const SHA = "a".repeat(40);
let restoreDialogPolyfill: () => void;
const containers: HTMLElement[] = [];

beforeEach(() => {
  restoreDialogPolyfill = installDialogPolyfill();
});
afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
  document.body.querySelector("openclaw-modal-dialog")?.parentElement?.remove();
  restoreDialogPolyfill();
});

async function openHeaderMenu(session: GatewaySessionRow, request: GatewayRequestHandler) {
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
  });
  state.settings = {} as ChatPageHost["settings"];
  pane.applyGatewaySnapshot({
    ...pane.context.gateway.snapshot,
    hello: gatewayHelloForMethods([...SESSION_MUTATION_TEST_METHODS, "projects.moveSession"]),
  });
  const container = document.body.appendChild(document.createElement("div"));
  containers.push(container);
  renderPaneHeaderInto(
    pane.renderPaneHeader(
      createPaneHeaderWorkspaceFixture(state),
      session,
      false,
      undefined,
      false,
      null,
    ),
    container,
  );
  const menu = expectDefined(
    container.querySelector<HTMLElementTagNameMap["openclaw-chat-header-session-menu"]>(
      "openclaw-chat-header-session-menu",
    ),
    "session menu",
  );
  await menu.updateComplete;
  expect(menu.openMenu()).toBe(true);
  await waitForSolid(() => expect(menu.querySelector('[data-value="rename"]')).not.toBeNull());
  return menu;
}

it("offers Move to project only to a conversation without a project", async () => {
  const request: GatewayRequestHandler = () => ({});
  const inProject = await openHeaderMenu(
    row({ key: "agent:main:current", projectId: "project-1" }),
    request,
  );
  expect(inProject.querySelector('[data-value="quick:move-to-project"]')).toBeNull();

  const unbound = await openHeaderMenu(row({ key: "agent:main:current" }), request);
  expect(unbound.querySelector('[data-value="quick:move-to-project"]')).not.toBeNull();
});

it("moves into the chosen project with the detected checkout", async () => {
  const request = vi.fn<GatewayRequestHandler>(async (method) => {
    if (method === "projects.moveSessionOptions") {
      return {
        available: true,
        projects: [
          { id: "project-1", name: "Website", checkouts: [] },
          {
            id: "project-2",
            name: "Billing",
            originUrl: "https://example.test/billing.git",
            checkouts: [
              { path: "billing", head: { sha: SHA, subject: "Add invoices" }, unsavedFiles: 2 },
            ],
          },
        ],
      };
    }
    if (method === "projects.moveSession") {
      return { status: "moved", projectId: "project-2", branch: "openclaw/billing" };
    }
    return method === "sessions.describe" ? { session: null } : {};
  });
  const menu = await openHeaderMenu(row({ key: "agent:main:current" }), request);
  expectDefined(
    menu.querySelector<HTMLElement>('[data-value="quick:move-to-project"]'),
    "move item",
  ).click();
  flush();

  const billing = await waitForSolid(() =>
    expectDefined(
      document.body.querySelector<HTMLInputElement>('input[name="project"][value="project-2"]'),
      "Billing option",
    ),
  );
  billing.click();
  flush();
  await waitForSolid(() =>
    expect(document.body.textContent).toContain(
      "Your work in billing comes along: last commit “Add invoices” and 2 unsaved files.",
    ),
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
  await waitForSolid(() => expect(document.body.querySelector("openclaw-modal-dialog")).toBeNull());
});
