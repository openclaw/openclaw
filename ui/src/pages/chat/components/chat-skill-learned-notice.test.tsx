import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import type { SkillWorkshopChangeNotice } from "../../../../../src/shared/skill-workshop-change-notice.js";
import { createDeferred } from "../../../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createContext } from "../../skill-workshop/skill-workshop-page.test-support.ts";
import { ChatSkillLearnedNotice } from "./chat-skill-learned-notice.tsx";

const notice: SkillWorkshopChangeNotice = {
  kind: "skill-workshop-change",
  agentId: "main",
  runId: "skill-workshop-review:r1",
  skills: [
    { name: "deploy-staging", action: "updated", summary: "tightened the rollback step" },
    { name: "release-notes", action: "created" },
  ],
};

function mount(context: ApplicationContext) {
  const provider = createSolidApplicationContextProvider(context);
  const view = mountSolid(() => <ChatSkillLearnedNotice notice={notice} />, {
    wrapper: provider.wrapper,
  });
  return view.container;
}

const undoButton = (element: HTMLElement) =>
  Array.from(element.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Undo"),
  );

describe("skill review notice", () => {
  it("undoes the whole review once and reports it as undone", async () => {
    const request = vi.fn(async () => ({ status: "undone", changes: [] }));
    const element = mount(createContext(request, { methods: ["skills.workshop.undo"] }));

    undoButton(element)?.click();
    undoButton(element)?.click();

    await waitForSolid(() => expect(element.textContent).toContain("Undone"));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("skills.workshop.undo", {
      agentId: "main",
      runId: "skill-workshop-review:r1",
    });
    expect(undoButton(element)).toBeUndefined();
  });

  it("keeps Undo available with the error when the revert fails", async () => {
    const request = vi.fn((): Promise<unknown> => {
      throw new Error("Learning is off.");
    });
    const element = mount(createContext(request, { methods: ["skills.workshop.undo"] }));

    undoButton(element)?.click();

    await waitForSolid(() =>
      expect(element.querySelector("[role='alert']")?.textContent).toContain("Learning is off."),
    );
    expect(undoButton(element)?.disabled).toBe(false);
    const retry = createDeferred<{ status: "undone"; changes: [] }>();
    request.mockReturnValueOnce(retry.promise);
    const button = undoButton(element)!;
    button.click();
    await waitForSolid(() => expect(button.disabled).toBe(true));
    expect(undoButton(element)).toBe(button);
    expect(element.querySelector("[role='alert']")).toBeNull();
    expect(element.textContent).toContain("Undoing");
    retry.resolve({ status: "undone", changes: [] });
    await waitForSolid(() => expect(element.textContent).toContain("Undone"));
  });

  it("retains the admitted Undo failure when a duplicate click is ignored", async () => {
    const response = createDeferred<unknown>();
    const request = vi.fn(() => response.promise);
    const element = mount(createContext(request, { methods: ["skills.workshop.undo"] }));
    const button = undoButton(element)!;

    button.click();
    button.click();
    expect(request).toHaveBeenCalledTimes(1);
    response.reject(new Error("Unable to revert this review."));

    await waitForSolid(() =>
      expect(element.querySelector("[role='alert']")?.textContent).toContain(
        "Unable to revert this review.",
      ),
    );
    expect(button.disabled).toBe(false);
  });

  it("retires pending Undo feedback when a different review replaces the notice", async () => {
    const response = createDeferred<{ status: "undone"; changes: [] }>();
    const request = vi.fn(() => response.promise);
    const context = createContext(request, { methods: ["skills.workshop.undo"] });
    const [current, setCurrent] = createSignal(notice);
    const view = mountSolid(() => <ChatSkillLearnedNotice notice={current()} />, {
      wrapper: createSolidApplicationContextProvider(context).wrapper,
    });

    undoButton(view.container)!.click();
    flush();
    expect(undoButton(view.container)?.disabled).toBe(true);
    expect(view.container.textContent).toContain("Undoing");

    setCurrent({ ...notice, runId: "skill-workshop-review:r2" });
    flush();
    expect(undoButton(view.container)?.disabled).toBe(false);
    response.resolve({ status: "undone", changes: [] });
    await response.promise;
    await Promise.resolve();
    flush();

    expect(view.container.textContent).not.toContain("Undone");
    expect(undoButton(view.container)?.disabled).toBe(false);
    expect(request).toHaveBeenCalledExactlyOnceWith("skills.workshop.undo", {
      agentId: "main",
      runId: notice.runId,
    });
  });

  it("offers no Undo to an operator without admin scope", async () => {
    const element = mount(
      createContext(vi.fn(), { methods: ["skills.workshop.undo"], scopes: ["operator.read"] }),
    );
    expect(element.textContent).toContain("deploy-staging");
    expect(undoButton(element)).toBeUndefined();
  });

  it("opens a skill under the notice's agent, not the agent selected elsewhere", async () => {
    // The fixture's sidebar selection is "research"; the notice belongs to "main".
    const context = createContext(vi.fn(), { methods: ["skills.workshop.undo"] });
    const element = mount(context);

    element.querySelector<HTMLButtonElement>("button[aria-label*='deploy-staging']")?.click();

    const select = vi.mocked(context.agentSelection.set);
    const navigate = vi.mocked(context.navigate);
    expect(select).toHaveBeenCalledWith("main");
    expect(navigate).toHaveBeenCalledWith("skill-workshop", { search: "?skill=deploy-staging" });
    // Selecting first means the Workshop resolves the notice's agent when it loads.
    expect(select.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      navigate.mock.invocationCallOrder[0] ?? -Infinity,
    );
  });
});
