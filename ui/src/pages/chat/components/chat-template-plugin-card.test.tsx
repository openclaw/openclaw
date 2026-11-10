/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { prepareChatMessageRender } from "../../../lib/chat/message-display.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createClient,
  createContext,
  createGateway,
} from "../../plugins/plugins-page.test-support.ts";
import { GroupedMessage } from "./chat-message-bubble-view.tsx";

beforeEach(async () => {
  await i18n.setLocale("en");
});

function mountTranscript(content: unknown[], role = "assistant") {
  const { client, request } = createClient(async (method) => {
    throw new Error("Unexpected RPC: " + method);
  });
  const context = createContext(createGateway(client).gateway);
  const navigate = vi.fn();
  context.navigate = navigate;
  const [message, setMessage] = createSignal({ role, content });
  const mounted = mountSolid(
    () => (
      <GroupedMessage
        preparation={prepareChatMessageRender(message())}
        messageKey="installer-receipts"
        options={{ isStreaming: false, showReasoning: false, agentId: "new-agent" }}
      />
    ),
    { wrapper: createSolidApplicationContextProvider(context).wrapper },
  );
  return { ...mounted, request, navigate, setMessage };
}

const receipts = Array.from({ length: 4 }, (_, index) => ({
  type: "template_plugin_install",
  pluginId: "community-plugin-" + index,
  packageName: "@community/plugin-" + index,
  displayName: "Community Plugin " + index,
  status: "installed",
  ...(index === 0 ? { official: false } : {}),
  iconUrl: "javascript:alert('untrusted icon')",
}));

it("renders all four community installer receipts, links their packages, and never offers installation", async () => {
  const view = mountTranscript(receipts);
  const cards = () => [
    ...view.container.querySelectorAll<HTMLElement>("[data-template-plugin-id]"),
  ];
  await waitForSolid(() => expect(cards()).toHaveLength(4));
  expect(
    cards().map((card) => card.querySelector(".chat-clawhub-card__name")?.textContent),
  ).toEqual(receipts.map((receipt) => receipt.displayName));
  expect(cards().every((card) => card.textContent?.includes("Installed"))).toBe(true);
  expect(view.container.querySelector(".plugin-official-badge")).toBeNull();
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.container.querySelector(".chat-clawhub-card__icon svg")).not.toBeNull();
  expect(view.container.querySelectorAll("button")).toHaveLength(4);
  expect(view.container.textContent).not.toMatch(/Retry|Install now|Add to agent/);
  cards()[0]!.querySelector<HTMLButtonElement>("button")!.click();
  expect(view.navigate).toHaveBeenCalledExactlyOnceWith("plugins", {
    pathname: "/plugins/community/plugin-0",
  });
  expect(view.request).not.toHaveBeenCalled();
});

it("shows one latest receipt per plugin with error status and badges only explicitly official receipts", async () => {
  const view = mountTranscript([
    receipts[0],
    { ...receipts[0], status: "error", error: "Dependency setup failed" },
    { ...receipts[1], official: true },
  ]);
  await waitForSolid(() =>
    expect(view.container.querySelectorAll("[data-template-plugin-id]")).toHaveLength(2),
  );
  const failed = view.container.querySelector('[data-template-plugin-id="community-plugin-0"]')!;
  expect(failed.textContent).toContain("Failed");
  expect(failed.textContent).toContain("Dependency setup failed");
  expect(failed.textContent).not.toContain("Installed");
  expect(view.container.querySelectorAll(".plugin-official-badge")).toHaveLength(1);
  expect(view.container.querySelectorAll("button")).toHaveLength(2);
  expect(view.request).not.toHaveBeenCalled();
});

it.each(["user", "toolResult"])("does not render %s-authored install claims", async (role) => {
  const view = mountTranscript(receipts, role);
  await vi.dynamicImportSettled();
  expect(view.container.querySelector("[data-template-plugin-id]")).toBeNull();
  expect(view.request).not.toHaveBeenCalled();
});

it("ignores malformed structured receipts and never parses text into installation facts", async () => {
  const view = mountTranscript([
    { ...receipts[0], pluginId: "" },
    { ...receipts[0], status: "recommended" },
    { type: "text", text: JSON.stringify(receipts[0]) },
  ]);
  await vi.dynamicImportSettled();
  expect(view.container.querySelector("[data-template-plugin-id]")).toBeNull();
  expect(view.container.textContent).toContain("template_plugin_install");
  expect(view.request).not.toHaveBeenCalled();
});
