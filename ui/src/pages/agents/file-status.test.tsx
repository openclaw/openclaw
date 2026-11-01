/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { observeState } from "../../lib/reactive/observe-state.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import type { AgentFileOutcome } from "./files.ts";
import { AgentFiles } from "./panels-files.tsx";

function mountFiles(onSave?: () => Promise<boolean>) {
  const fixture = createAgentViewTestProps();
  let state!: ReturnType<typeof fixture.readData>;
  const view = mountSolid(() => {
    const observation = observeState({
      ...fixture.readData(),
      agentFilesList: {
        agentId: "main",
        workspace: "/synthetic/garden",
        files: [{ name: "AGENTS.md", path: "/synthetic/garden/AGENTS.md", missing: false }],
      },
      agentFileActive: "AGENTS.md",
      agentFileEditors: { "AGENTS.md": { content: "Original", draft: "Edited" } },
    });
    state = observation.state;
    return (
      <AgentFiles
        {...fixture.agentFiles}
        presentationRetired={fixture.presentationRetired}
        readData={observation.read}
        agentId="main"
        canWrite
        onFileSave={onSave ?? (() => undefined)}
      />
    );
  });
  return {
    view,
    button: (name: string | RegExp, disabled: boolean) =>
      expect(view.getByRole("button", { name })).toHaveProperty("disabled", disabled),
    text: (text: string) => waitForSolid(() => expect(view.container.textContent).toContain(text)),
    get state() {
      return state;
    },
  };
}

describe("agent file native status", () => {
  it("presents pending reads and failures without replacing the editor on retry", async () => {
    const mounted = mountFiles();
    const editor = mounted.view.container.querySelector("textarea");
    const first = createDeferred<AgentFileOutcome>();
    mounted.state.agentFileRead = first.promise;
    mounted.state.agentFileOutcome = first.promise;
    await waitForSolid(() => mounted.button(/^Loading/, true));

    first.resolve({ error: "Synthetic file unavailable" });
    await mounted.text("Synthetic file unavailable");
    const retry = createDeferred<AgentFileOutcome>();
    mounted.state.agentFileRead = retry.promise;
    mounted.state.agentFileOutcome = retry.promise;
    await waitForSolid(() =>
      expect(mounted.view.container.textContent).not.toContain("Synthetic file unavailable"),
    );
    retry.resolve({ result: true });
    await waitForSolid(() => mounted.button("Refresh", false));
    expect(mounted.view.container.querySelector("textarea")).toBe(editor);
    expect(editor).toHaveProperty("value", "Edited");
  });

  it("shows the admitted save immediately, retains editable drafts and exposes its failed outcome", async () => {
    const outcome = createDeferred<AgentFileOutcome>();
    const write = createDeferred<boolean>();
    const mounted = mountFiles(() => {
      mounted.state.agentFileSaving = true;
      mounted.state.agentFileOutcome = outcome.promise;
      return write.promise.finally(() => {
        mounted.state.agentFileSaving = false;
      });
    });
    const editor = mounted.view.container.querySelector("textarea");
    mounted.view.getByRole("button", { name: /^Save$/ }).click();
    await waitForSolid(() => mounted.button(/^Saving/, true));
    expect(editor).toHaveProperty("disabled", false);
    mounted.state.agentFileEditors = {
      "AGENTS.md": { content: "Original", draft: "A newer edit" },
    };
    outcome.resolve({ error: "Synthetic write rejected" });
    write.resolve(false);
    await mounted.text("Synthetic write rejected");
    mounted.button(/^Save$/, false);
    expect(mounted.view.container.querySelector("textarea")).toBe(editor);
    expect(editor).toHaveProperty("value", "A newer edit");
  });

  it("keeps conflict recovery available after a successful refresh retains the dirty draft", async () => {
    const mounted = mountFiles();
    mounted.state.agentFileConflict = "AGENTS.md";
    mounted.state.agentFileOutcome = Promise.resolve({ error: "Synthetic file conflict" });
    await waitForSolid(() =>
      expect(mounted.view.getByRole("button", { name: "Overwrite" })).toBeTruthy(),
    );

    mounted.state.agentFileOutcome = Promise.resolve({ result: true });
    await waitForSolid(() =>
      expect(mounted.view.container.textContent).not.toContain("Synthetic file conflict"),
    );
    expect(mounted.view.getByRole("button", { name: /^Reload$/ })).toBeTruthy();
    mounted.button(/^Overwrite$/, false);
    expect(mounted.view.container.querySelector("textarea")).toHaveProperty("value", "Edited");
  });
});
