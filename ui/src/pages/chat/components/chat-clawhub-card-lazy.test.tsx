/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { ClawHubRecommendation } from "../../../../../src/shared/clawhub-recommendations.js";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import {
  createClient,
  createContext,
  createGateway,
} from "../../plugins/plugins-page.test-support.ts";
import { ChatClawHubCard } from "./chat-clawhub-card.tsx";

it("keeps the current listing usable while its card body is loading", async () => {
  const loading = createDeferred();
  vi.doMock(import("./chat-clawhub-card-body.tsx"), async (original) => {
    await loading.promise;
    return original();
  });
  onTestFinished(() => {
    loading.resolve();
    vi.doUnmock("./chat-clawhub-card-body.tsx");
  });
  const official: ClawHubRecommendation = {
    type: "clawhub",
    kind: "plugin",
    id: "ch_official",
    name: "Official plugin",
    description: "Official description",
    official: true,
    installed: false,
  };
  const [recommendation, setRecommendation] = createSignal<ClawHubRecommendation | undefined>(
    official,
  );
  const { client } = createClient(async () => {
    throw new Error("No status request while loading");
  });
  const context = createContext(createGateway(client).gateway);
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => <ChatClawHubCard recommendation={recommendation()} />, {
    wrapper: provider.wrapper,
  });
  onTestFinished(view.unmount);
  const card = view.container.querySelector(".chat-clawhub-card")!;
  expect(card.getAttribute("aria-busy")).toBe("true");
  expect(card.textContent).toContain(official.name);
  expect(card.querySelector(".plugin-official-badge")).not.toBeNull();
  setRecommendation({
    ...official,
    id: "ch_community",
    name: "Community plugin",
    description: "Community description",
    official: false,
  });
  flush();
  await waitForSolid(() => {
    expect(view.container.querySelector(".chat-clawhub-card")).toBe(card);
    expect(card.textContent).toContain("Community description");
    expect(card.querySelector(".plugin-official-badge")).toBeNull();
  });
  card.querySelector<HTMLButtonElement>(".chat-clawhub-card__listing")!.click();
  expect(context.navigate).toHaveBeenLastCalledWith("plugins", {
    pathname: "/plugins/ch_community",
    search: "",
  });
  expect(card.querySelector(".chat-clawhub-card__install")).toBeNull();
  setRecommendation(undefined);
  flush();
  await waitForSolid(() => expect(view.container.querySelector(".chat-clawhub-card")).toBeNull());
});
