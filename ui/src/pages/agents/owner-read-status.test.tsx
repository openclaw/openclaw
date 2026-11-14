/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentReadOutcome } from "../../lib/agents/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import { AgentFiles } from "./panels-files.tsx";
import { Agents } from "./view.tsx";

describe.each(["roster", "file inventory"] as const)("Agents %s native read", (kind) => {
  it("disables the initial refresh while a previously admitted read settles", async () => {
    const pending = createDeferred<AgentReadOutcome<never> | null>();
    const fixture = createAgentViewTestProps();
    const view = mountSolid(() =>
      kind === "roster" ? (
        <Agents {...fixture} listRead={pending.promise} />
      ) : (
        <AgentFiles
          {...fixture.agentFiles}
          readData={fixture.readData}
          presentationRetired={fixture.presentationRetired}
          agentId="beta"
          canWrite
          listRead={pending.promise}
        />
      ),
    );
    const button = view.getByRole("button", { name: /^(Refresh|Loading.*)$/ });
    expect(button).toHaveProperty("disabled", true);
    pending.resolve({ result: null });
    await waitForSolid(() => expect(button).toHaveProperty("disabled", false));
  });

  it("shows current failures, clears them on retry and retains the refresh control", async () => {
    const first = createDeferred<AgentReadOutcome<never> | null>();
    const retry = createDeferred<AgentReadOutcome<never> | null>();
    const [request, setRequest] = createSignal<Promise<AgentReadOutcome<never> | null> | null>(
      null,
    );
    const refresh = vi
      .fn()
      .mockImplementationOnce(() => setRequest(first.promise))
      .mockImplementationOnce(() => setRequest(retry.promise));
    const fixture = createAgentViewTestProps();
    const view = mountSolid(() =>
      kind === "roster" ? (
        <Agents {...fixture} listRead={request()} onRefresh={refresh} />
      ) : (
        <AgentFiles
          {...fixture.agentFiles}
          readData={fixture.readData}
          presentationRetired={fixture.presentationRetired}
          agentId="beta"
          canWrite
          listRead={request()}
          onLoadFiles={refresh}
        />
      ),
    );
    const button = view.getByRole("button", { name: "Refresh" });
    button.click();
    await waitForSolid(() => expect(button).toHaveProperty("disabled", true));
    expect(view.container.querySelector(".callout.danger")).toBeNull();

    first.resolve({ error: "Inventory unavailable" });
    await waitForSolid(() => expect(view.container.textContent).toContain("Inventory unavailable"));
    expect(button).toHaveProperty("disabled", false);
    button.click();
    await waitForSolid(() => {
      expect(button).toHaveProperty("disabled", true);
      expect(view.container.querySelector(".callout.danger")).toBeNull();
    });

    retry.resolve({ result: null });
    await waitForSolid(() => expect(button).toHaveProperty("disabled", false));
    expect(view.getByRole("button", { name: "Refresh" })).toBe(button);
    expect(view.container.querySelector(".callout.danger")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
