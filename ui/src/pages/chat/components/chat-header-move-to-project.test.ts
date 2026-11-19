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
  renderPaneHeaderInto,
  selectNativeMenu,
} from "./chat-pane-header.test-support.ts";
import "./chat-header-session-menu.ts";

it("moves into the chosen project with the detected checkout", async () => {
  installDialogPolyfill();
  const request = vi.fn<GatewayRequestHandler>(async (method) => {
    if (method === "projects.moveSessionOptions") {
      return {
        available: true,
        projects: [
          { id: "project-1", name: "Website", checkouts: [] },
          {
            id: "project-2",
            name: "Billing",
            checkouts: [{ path: "billing" }],
          },
        ],
      };
    }
    return method === "projects.moveSession" ? { status: "pending", projectId: "project-2" } : {};
  });
  const { pane, state } = createTestChatPane({
    client: createGatewayBrowserClientFixture({ request }),
  });
  state.settings = {} as ChatPageHost["settings"];
  pane.applyGatewaySnapshot({
    ...pane.context.gateway.snapshot,
    hello: gatewayHelloForMethods([...SESSION_MUTATION_TEST_METHODS, "projects.moveSession"]),
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
  const menu = expectDefined(container.querySelector("openclaw-chat-header-session-menu"), "menu");
  await selectNativeMenu(menu, "quick:move-to-project");

  const billing = await waitForSolid(() =>
    expectDefined(
      document.body.querySelector<HTMLInputElement>('input[name="project"][value="project-2"]'),
      "Billing option",
    ),
  );
  billing.click();
  flush();
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
