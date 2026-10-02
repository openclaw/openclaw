/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupAgentsHomePageTest,
  createPage,
  orphanedClaw,
  orphanRemovePlan,
  roster,
  setupAgentsHomePageTest,
} from "./agents-home-page.test-helpers.ts";
import type { ClawStatusRecord } from "./claws-catalog-client.ts";

beforeEach(setupAgentsHomePageTest);
afterEach(cleanupAgentsHomePageTest);

describe("AgentsHomePage", () => {
  it("shows an unrepresented installed Claw on an empty roster with Labs off and opens its lifecycle panel", async () => {
    const { page, request, navigate } = createPage({
      roster: { ...roster, agents: [] },
      statusRecords: [orphanedClaw],
      removePlan: orphanRemovePlan,
    });

    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    expect(request).toHaveBeenCalledWith("claws.status", {});
    expect(page.querySelectorAll(".agents-home__card")).toHaveLength(0);
    expect(page.querySelector(".agents-home__empty")).toBeNull();
    expect(page.querySelector("[data-claws-explore]")).toBeNull();
    const row = page.querySelector<HTMLElement>('[data-claw-unrepresented="orphan-worker"]');
    expect(row?.textContent).toContain("@openclaw/orphan-worker");
    expect(row?.textContent).toContain("Partial");
    expect(row?.querySelector("a[href*='chat']")).toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    row?.querySelector<HTMLButtonElement>("[data-claw-inspect]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector("openclaw-agent-claw-panel")?.textContent).toContain("audit@2.0.0"),
    );
    expect(request).toHaveBeenCalledWith("claws.status", { target: "orphan-worker" });
    expect(page.querySelector("[data-claw-update]")).toBeNull();
    expect(
      page.querySelector("openclaw-agent-claw-panel .settings-row .btn.danger"),
    ).not.toBeNull();
  });

  it("discovers an orphan installed outside the UI when Agents regains focus", async () => {
    const { page, request, setStatusRecords } = createPage({
      roster: { ...roster, agents: [] },
      statusRecords: [],
    });
    await vi.waitFor(() => expect(page.querySelector(".agents-home__empty")).not.toBeNull());
    expect(page.querySelector("[data-claws-attention]")).toBeNull();

    setStatusRecords([orphanedClaw]);
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    expect(request.mock.calls.filter(([method]) => method === "claws.status")).toHaveLength(2);
  });

  it("closes an idle inspector when its Claw gains a roster card", async () => {
    const { page, setRoster } = createPage({
      roster: { ...roster, agents: [] },
      statusRecords: [orphanedClaw],
    });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-claw-inspect]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector("openclaw-agent-claw-panel")?.textContent).toContain("audit@2.0.0"),
    );

    await setRoster({ ...roster, agents: [{ id: "orphan-worker" }] });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-agent-id="orphan-worker"]')).not.toBeNull(),
    );
    await vi.waitFor(() => expect(page.querySelector("[data-claws-attention]")).toBeNull());
    expect(page.querySelector("openclaw-agent-claw-panel")).toBeNull();
  });

  it("removes an orphaned Claw through the reviewed plan without claiming its absent agent was removed", async () => {
    const { page, request, navigate } = createPage({
      roster: { ...roster, agents: [] },
      statusRecords: [orphanedClaw],
      removePlan: orphanRemovePlan,
      removeApplyResult: {
        agentId: "orphan-worker",
        status: "complete",
        agentRemoved: false,
      },
    });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-claw-inspect]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector("openclaw-agent-claw-panel")?.textContent).toContain("audit@2.0.0"),
    );
    page
      .querySelector<HTMLButtonElement>("openclaw-agent-claw-panel .settings-row .btn.danger")
      ?.click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    expect(request).toHaveBeenCalledWith("claws.remove.plan", { agentId: "orphan-worker" });
    expect(page.textContent).toContain("plugin:audit@2.0.0");
    expect(request).not.toHaveBeenCalledWith("claws.remove.apply", expect.anything());

    page.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("claws.remove.apply", {
        agentId: "orphan-worker",
        planIntegrity: "sha256:orphan-remove-plan",
      }),
    );
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).toBeNull(),
    );
    expect(page.querySelector("openclaw-agent-claw-panel")).toBeNull();
    expect(page.textContent).toContain("Claw removed");
    expect(page.textContent).not.toContain("Removal incomplete");
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      1,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows only Claws without roster cards and replaces their status after reconnect", async () => {
    const representedClaw: ClawStatusRecord = {
      ...orphanedClaw,
      agentId: "harbor",
      name: "@openclaw/harbor",
      status: "complete",
      agentState: "present",
      bootstrapState: "complete",
      orphaned: false,
    };
    const { page, request, setPhase, setStatusRecords } = createPage({
      statusRecords: [representedClaw, orphanedClaw],
    });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    expect(page.querySelector('[data-claw-unrepresented="harbor"]')).toBeNull();
    expect(page.querySelectorAll(".agents-home__card")).toHaveLength(2);
    page.querySelector<HTMLButtonElement>("[data-claw-inspect]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector("openclaw-agent-claw-panel")?.textContent).toContain("audit@2.0.0"),
    );

    setPhase("reconnecting");
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).toBeNull(),
    );
    setStatusRecords([representedClaw]);
    setPhase("connected");
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === "claws.status" && !Object.hasOwn(params ?? {}, "target"),
        ),
      ).toHaveLength(2),
    );
    await vi.waitFor(() => expect(page.querySelector("[data-claws-attention]")).toBeNull());
  });

  it("reconciles timed-out orphan removal from status without applying it twice", async () => {
    const { page, request, navigate } = createPage({
      roster: { ...roster, agents: [] },
      statusRecords: [orphanedClaw],
      removePlan: orphanRemovePlan,
      removeApplyError: true,
      removeAppliedBeforeError: true,
    });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-claw-inspect]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector("openclaw-agent-claw-panel")?.textContent).toContain("audit@2.0.0"),
    );
    page
      .querySelector<HTMLButtonElement>("openclaw-agent-claw-panel .settings-row .btn.danger")
      ?.click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    page.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();

    await vi.waitFor(() => expect(page.textContent).toContain("Claw removed"));
    expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).toBeNull();
    expect(request).toHaveBeenCalledWith("claws.status", { target: "orphan-worker" });
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      1,
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous orphan removal inspector mounted until status confirms cleanup", async () => {
    const { page, request, setRoster, setStatusRecords } = createPage({
      roster: { ...roster, agents: [] },
      statusRecords: [orphanedClaw],
      removePlan: orphanRemovePlan,
      removeApplyError: true,
    });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).not.toBeNull(),
    );
    page.querySelector<HTMLButtonElement>("[data-claw-inspect]")?.click();
    await vi.waitFor(() =>
      expect(page.querySelector("openclaw-agent-claw-panel")?.textContent).toContain("audit@2.0.0"),
    );
    page
      .querySelector<HTMLButtonElement>("openclaw-agent-claw-panel .settings-row .btn.danger")
      ?.click();
    await vi.waitFor(() =>
      expect(page.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.disabled).toBe(
        false,
      ),
    );
    page.querySelector<HTMLButtonElement>("[data-claw-remove-confirm]")?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Removal outcome unknown"));
    page.querySelector<HTMLButtonElement>(".claw-lifecycle-dialog__footer .btn")?.click();
    await vi.waitFor(() => expect(page.querySelector(".claw-lifecycle-dialog")).toBeNull());

    const inspect = page.querySelector<HTMLButtonElement>("[data-claw-inspect]");
    expect(inspect?.disabled).toBe(true);
    inspect?.click();
    expect(page.querySelector("openclaw-agent-claw-panel")).not.toBeNull();

    await setRoster({ ...roster, agents: [{ id: "orphan-worker" }] });
    await vi.waitFor(() =>
      expect(page.querySelector('[data-agent-id="orphan-worker"]')).not.toBeNull(),
    );
    expect(page.querySelector("openclaw-agent-claw-panel")).not.toBeNull();

    setStatusRecords([]);
    page
      .querySelector<HTMLButtonElement>("openclaw-agent-claw-panel .callout.warn button")
      ?.click();
    await vi.waitFor(() => expect(page.textContent).toContain("Claw removed"));
    expect(page.querySelector('[data-claw-unrepresented="orphan-worker"]')).toBeNull();
    expect(request.mock.calls.filter(([method]) => method === "claws.remove.apply")).toHaveLength(
      1,
    );
  });
});
