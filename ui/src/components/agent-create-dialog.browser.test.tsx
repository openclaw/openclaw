import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { ApplicationContext } from "../app/context.ts";
import "../styles.css";
import { AgentCreateDialog } from "./agent-create-dialog.tsx";
import "./modal-dialog.tsx";

afterEach(cleanup);

it.each([320, 1024])(
  "fits the agent creation form to its centered modal at %s px",
  async (width) => {
    await page.viewport(width, 768);
    // The initial picker only reads the roster; no Gateway action is invoked.
    const context = { agents: { state: { agentsList: null } } } as ApplicationContext;
    const view = render(() => (
      <AgentCreateDialog context={context} onCancel={() => {}} onCreate={() => {}} />
    ));
    const form = view.container.querySelector<HTMLElement>(".agent-create-dialog")!;
    await expect.element(page.getByRole("heading", { name: "Create new agent" })).toBeVisible();
    const shell = form.closest("dialog")!;
    await expect
      .poll(() => {
        const bounds = form.getBoundingClientRect();
        return Math.abs(bounds.left + bounds.width / 2 - innerWidth / 2);
      })
      .toBeLessThanOrEqual(1);
    expect(form.getBoundingClientRect().width).toBeCloseTo(shell.getBoundingClientRect().width, 1);
  },
);
