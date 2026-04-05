import { describe, expect, it } from "vitest";
import { PendingMessagesComponent } from "./pending-messages.js";

describe("PendingMessagesComponent", () => {
  it("renders queued steering and follow-up messages", () => {
    const component = new PendingMessagesComponent();
    component.setMessages([
      { runId: "run-1", text: "continue", mode: "steer" },
      { runId: "run-2", text: "after that, write tests", mode: "followUp" },
    ]);

    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("Steer: continue");
    expect(rendered).toContain("Follow-up: after that, write tests");
    expect(rendered).toContain("alt+up");
  });

  it("clears its output when no queued messages remain", () => {
    const component = new PendingMessagesComponent();
    component.setMessages([{ runId: "run-1", text: "continue", mode: "steer" }]);
    component.clearMessages();

    expect(component.render(120).join("\n")).toBe("");
  });
});
