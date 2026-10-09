import { render } from "lit";
import { expect, it } from "vitest";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

it("surfaces agent config save errors in the active panel", () => {
  const container = document.createElement("div");
  render(
    renderAgents(
      createAgentViewTestProps({
        config: {
          configForm: { agents: { entries: { beta: {} } } },
          configSnapshot: null,
          configLoading: false,
          configSaving: false,
          configFormDirty: true,
          lastError: "mock validation failure",
        },
      }),
    ),
    container,
  );

  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("mock validation failure");
});
