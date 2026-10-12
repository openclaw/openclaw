import { expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { mountView } from "./mcp-app-view.test-support.ts";

it("reserves the conversation height before its frame request completes", async () => {
  const response = createDeferred<unknown>();
  const { view, unmount } = mountView(
    { sessionKey: "agent:main:main", viewId: "delayed-view", height: 840 },
    {
      gateway: { snapshot: { client: { request: () => response.promise }, phase: "connected" } },
    },
  );
  await view.updateComplete;
  const mount = view.querySelector<HTMLElement>(".mount")!;
  expect(view.querySelector("iframe")).toBeNull();
  expect(mount.style.minHeight).toBe("840px");
  view.fillContainer = true;
  await view.updateComplete;
  expect(mount.style.minHeight).toBe("");
  view.fillContainer = false;
  view.displayMode = "fullscreen";
  await view.updateComplete;
  expect(mount.style.minHeight).toBe("");
  unmount();
  response.resolve({});
});
