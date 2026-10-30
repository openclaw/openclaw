/* @vitest-environment jsdom */

import { createMemo } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { observeState } from "../../lib/reactive/observe-state.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  agentsCapability,
  agentsList,
  agentsRouteData,
  createAgentsPage,
  gateway,
  pageContext,
  settingsSelection,
  snapshot,
} from "./agents-page.test-support.ts";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import type { AgentIdentityOutcome } from "./identity-actions.ts";
import { Agents } from "./view.tsx";

it("keeps identity inputs editable through an admitted save and clears its error on a new edit", async () => {
  const fixture = createAgentViewTestProps();
  let state!: ReturnType<typeof fixture.readData>;
  const mounted = mountSolid(() => {
    const observation = observeState({ ...fixture.readData() });
    state = observation.state;
    return (
      <Agents
        {...fixture}
        readData={observation.read}
        overview={{
          ...fixture.overview,
          onIdentityFieldChange(field, value) {
            state.identityDraft = { ...state.identityDraft, [field]: value };
            state.identityOutcome = null;
          },
        }}
      />
    );
  });
  const input = mounted.container.querySelector<HTMLInputElement>(
    ".agent-identity-editor__fields input",
  )!;
  const completion = createDeferred<AgentIdentityOutcome>();
  state.identityDraft = { name: "Garden guide", emoji: null, avatar: null };
  state.identitySaving = true;
  state.identityOutcome = completion.promise;
  await waitForSolid(() => expect(input.value).toBe("Garden guide"));
  expect(input.disabled).toBe(false);

  completion.resolve({ error: "Synthetic identity save rejected" });
  state.identitySaving = false;
  await waitForSolid(() =>
    expect(mounted.getByRole("alert").textContent).toContain("Synthetic identity save rejected"),
  );
  expect(mounted.container.querySelector(".agent-identity-editor__fields input")).toBe(input);
  expect(input.value).toBe("Garden guide");
  expect(input.disabled).toBe(false);

  input.value = "Garden curator";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await waitForSolid(() => expect(mounted.queryByRole("alert")).toBeNull());
  expect(state.identityDraft.name).toBe("Garden curator");
  expect(mounted.container.querySelector(".agent-identity-editor__fields input")).toBe(input);
});

it("switches identity editors while the previous agent save is pending", async () => {
  const pending = createDeferred();
  const retiredBeforePresentation = createDeferred();
  const request = vi.fn(() => pending.promise);
  const client = { request } as unknown as GatewayBrowserClient;
  const currentGateway = gateway(snapshot(client));
  const roster = {
    ...agentsList,
    agents: [
      { id: "main", name: "Main" },
      { id: "research", name: "Research" },
    ],
  };
  const selection = settingsSelection(roster);
  const agents = agentsCapability(async () => ({ agentId: "main", workspace: "", files: [] }));
  agents.state.agentsList = roster;
  const context = pageContext(currentGateway, agents);
  const runExternalMutation: ApplicationContext["runtimeConfig"]["runExternalMutation"] = async (
    task,
  ) => ({
    ok: true,
    value: await task(client),
    refresh: { ok: true },
  });
  const routeData = {
    ...agentsRouteData(currentGateway, roster, "main", selection),
    panel: "overview" as const,
  };
  const page = createAgentsPage(
    {
      ...context,
      settingsAgentSelection: selection,
      runtimeConfig: { ...context.runtimeConfig, runExternalMutation },
    },
    routeData,
  );
  const mounted = mountSolid(() => {
    const props = createMemo(() => page.read());
    return <Agents {...props()} identitySavePending={page.identitySavePending()} />;
  });
  const input = () =>
    mounted.container.querySelector<HTMLInputElement>(".agent-identity-editor__fields input")!;
  const saving = () => mounted.container.querySelector('.agent-identity-editor [role="status"]');
  const edit = (name: string) => {
    input().value = name;
    input().dispatchEvent(new Event("input", { bubbles: true }));
    input().dispatchEvent(new Event("blur"));
  };
  try {
    edit("Main draft");
    await waitForSolid(() =>
      expect(request).toHaveBeenCalledWith("agents.update", {
        agentId: "main",
        name: "Main draft",
      }),
    );
    await waitForSolid(() => expect(saving()?.textContent).toContain("Saving"));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    page.setRouteData({ ...routeData, panel: "files" });
    await waitForSolid(() =>
      expect(mounted.container.querySelector(".agent-identity-editor")).toBeNull(),
    );
    page.setRouteData(routeData);
    await waitForSolid(() => {
      expect(input().value).toBe("Main draft");
      expect(saving()?.textContent).toContain("Saving");
    });
    selection.set("research");
    await waitForSolid(() => {
      expect(input().value).toBe("Research");
      expect(input().disabled).toBe(false);
      expect(saving()).toBeNull();
    });
    pending.resolve();
    await pending.promise;
    expect(input().value).toBe("Research");
    selection.set("main");
    await waitForSolid(() => expect(input().value).toBe("Main draft"));

    request.mockImplementationOnce(() => retiredBeforePresentation.promise);
    edit("Main next draft");
    selection.set("research");
    await waitForSolid(() => {
      expect(input().value).toBe("Research");
      expect(saving()).toBeNull();
    });
    retiredBeforePresentation.resolve();
  } finally {
    pending.resolve();
    retiredBeforePresentation.resolve();
    mounted.unmount();
    page.dispose();
    selection.dispose();
  }
});
