import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillWorkshopChangeNotice } from "../../../../../src/shared/skill-workshop-change-notice.js";
import { applicationContext, type ApplicationContext } from "../../../app/context.ts";
import { createContext } from "../../skill-workshop/skill-workshop-page.test-support.ts";
import "./chat-skill-learned-notice.tsx";

const notice: SkillWorkshopChangeNotice = {
  kind: "skill-workshop-change",
  agentId: "main",
  runId: "skill-workshop-review:r1",
  skills: [
    { name: "deploy-staging", action: "updated", summary: "tightened the rollback step" },
    { name: "release-notes", action: "created" },
  ],
};

async function mount(context: ApplicationContext) {
  const element = document.createElement("openclaw-chat-skill-learned-notice");
  element.context = context;
  element.notice = notice;
  document.body.append(element);
  flush();
  return element;
}

const undoButton = (element: HTMLElement) =>
  Array.from(element.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Undo"),
  );

afterEach(() => document.body.replaceChildren());

describe("skill review notice", () => {
  it("undoes the whole review once and reports it as undone", async () => {
    const completion = Promise.withResolvers<void>();
    const request = vi.fn(() => completion.promise);
    const element = await mount(createContext(request, { methods: ["skills.workshop.undo"] }));

    const button = undoButton(element);
    button?.click();
    button?.click();
    flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-busy")).toBe("true");
    expect(button?.querySelector(".btn__spinner")).not.toBeNull();
    completion.resolve();

    await vi.waitFor(() => expect(element.textContent).toContain("Undone"));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("skills.workshop.undo", {
      agentId: "main",
      runId: "skill-workshop-review:r1",
    });
    expect(undoButton(element)).toBeUndefined();
  });

  it("keeps Undo available with the error when the revert fails", async () => {
    const request = vi.fn(async () => {
      throw new Error("Learning is off.");
    });
    const element = await mount(createContext(request, { methods: ["skills.workshop.undo"] }));

    undoButton(element)?.click();

    await vi.waitFor(() =>
      expect(element.querySelector("[role='alert']")?.textContent).toContain("Learning is off."),
    );
    expect(undoButton(element)?.disabled).toBe(false);
  });

  it("offers no Undo to an operator without admin scope", async () => {
    const element = await mount(
      createContext(vi.fn(), { methods: ["skills.workshop.undo"], scopes: ["operator.read"] }),
    );
    expect(element.textContent).toContain("deploy-staging");
    expect(undoButton(element)).toBeUndefined();
  });

  it("opens a skill under the notice's agent, not the agent selected elsewhere", async () => {
    // The fixture's sidebar selection is "research"; the notice belongs to "main".
    const context = createContext(vi.fn(), { methods: ["skills.workshop.undo"] });
    const element = await mount(context);

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

  it("subscribes through the context protocol and disposes on disconnect", () => {
    const context = createContext(vi.fn(), { methods: ["skills.workshop.undo"] });
    const unsubscribe = vi.fn();
    const parent = document.createElement("div");
    const element = document.createElement("openclaw-chat-skill-learned-notice");
    element.notice = notice;
    parent.addEventListener("context-request", (event) => {
      expect(event.context).toBe(applicationContext);
      expect(event.contextTarget).toBe(element);
      expect(event.subscribe).toBe(true);
      event.callback(context, unsubscribe);
    });
    document.body.append(parent);
    parent.append(element);
    flush();
    expect(undoButton(element)).toBeDefined();
    element.remove();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(element.childNodes).toHaveLength(0);
  });
});
