/* @vitest-environment jsdom */
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../test-helpers/solid-settle.ts";
import { createSkillFileHovercard } from "./skill-file-hovercard.tsx";

const file = {
  path: "/skills/release-notes/SKILL.md",
  name: "release-notes",
  content: "---\nname: release-notes\n---\n# Release notes\n",
};

function setup() {
  const request = createGatewayRequestMock(async () => file);
  const client = createTestGatewayClient(request);
  let changeAgent: (value: string) => void = () => {};
  const view = mountSolid(() => {
    const [agent, setAgent] = createSignal("main");
    changeAgent = setAgent;
    const ref = createSkillFileHovercard({
      client,
      get agentId() {
        return agent();
      },
      sessionKey: "agent:main:main",
      onOpenFile: vi.fn(),
    });
    return (
      <div ref={ref}>
        <a href="#" data-file-path={file.path}>
          release-notes
        </a>
        <a href="#" data-file-path="README.md">
          README
        </a>
      </div>
    );
  });
  flush();
  return { ...view, request, changeAgent, anchor: view.getByText("release-notes") };
}

async function focus(anchor: HTMLElement) {
  anchor.focus();
  await waitForSolid(() =>
    expect(document.querySelector(".skill-file-hovercard__source")).not.toBeNull(),
  );
}

afterEach(() => {
  cleanupSolid();
  vi.restoreAllMocks();
});

describe("skill file hover preview", () => {
  it("loads on intent, renders source as text, and rereads after dismissal", async () => {
    const { anchor, request } = setup();
    expect(request).not.toHaveBeenCalled();
    request.mockResolvedValueOnce({ ...file, content: "<img src=x onerror=alert(1)>" });
    await focus(anchor);
    expect(document.querySelector(".skill-file-hovercard__source")?.textContent).toContain(
      "<img src=x",
    );
    expect(document.querySelector(".skill-file-hovercard__source img")).toBeNull();
    anchor.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".skill-file-hovercard")).toBeNull();
    anchor.blur();
    await focus(anchor);
    expect(request).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".skill-file-hovercard__source")?.textContent).toContain(
      "# Release notes",
    );
  });

  it("retires pending requests when the agent changes or the trigger is removed", async () => {
    const { changeAgent, anchor, request } = setup();
    let resolve: (value: typeof file) => void = () => {};
    request.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    anchor.focus();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const signal = request.mock.calls[0]?.[2]?.signal;
    changeAgent("other");
    flush();
    expect(signal?.aborted).toBe(true);
    resolve(file);
    await Promise.resolve();
    expect(document.querySelector(".skill-file-hovercard")).toBeNull();
    request.mockResolvedValue(file);
    anchor.blur();
    await focus(anchor);
    anchor.remove();
    await waitForSolid(() => expect(document.querySelector(".skill-file-hovercard")).toBeNull());
  });

  it("keeps ordinary files untouched and exposes a retry after a failed read", async () => {
    const view = setup();
    const { anchor, request } = view;
    view.getByText("README").focus();
    expect(request).not.toHaveBeenCalled();
    request.mockRejectedValueOnce(new Error("not installed"));
    anchor.click();
    await waitForSolid(() =>
      expect(document.querySelector(".skill-file-hovercard")?.textContent).toContain(
        "Skill file unavailable",
      ),
    );
    const retry = [
      ...document.querySelectorAll<HTMLButtonElement>(".skill-file-hovercard button"),
    ].find((button) => button.textContent?.includes("Retry"));
    retry?.click();
    await waitForSolid(() =>
      expect(document.querySelector(".skill-file-hovercard__source")).not.toBeNull(),
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});
