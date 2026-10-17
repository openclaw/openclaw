/* @vitest-environment jsdom */

import { describe, expect, it, onTestFinished, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult, GatewayAgentRow, GatewaySessionRow } from "../api/types.ts";
import type { RouteId } from "../app-routes.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { createShellOwner, mountShellView, settleShell } from "./app-host-solid.test-support.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "./theme-branding.ts";

type ShellDocumentTitleState = {
  activeSessionKey: string;
  routeState: { routeId?: RouteId };
  runtime?: { context: ApplicationContext };
  syncDocumentTitle: () => void;
};

function expectTitle(shell: ShellDocumentTitleState, title: string, routeId?: RouteId) {
  if (routeId) {
    shell.routeState = { routeId };
  }
  shell.syncDocumentTitle();
  expect(document.title).toBe(title);
}

function roster(agents: GatewayAgentRow[]): AgentsListResult {
  return { defaultId: "main", mainKey: "main", scope: "per-sender", agents };
}

function sessionRow(key: string, fields: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, kind: "direct", updatedAt: 1, ...fields };
}

setupSidebarTest();

async function createConnectedSessionShell() {
  vi.useFakeTimers();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestIdleCallback", vi.fn());
  const active = sessionRow("agent:main:quarterly-launch", {
    derivedTitle: "Quarterly launch plan",
  });
  const background = sessionRow("agent:main:background-task");
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    return sessionsResult([active, background], 1);
  });
  const harness = createSessionCapabilityHarness(request as GatewayBrowserClient["request"]);
  await harness.sessions.refresh({ force: true });
  const runtime = bootstrapApplication();
  onTestFinished(() => runtime.stop());
  const context = { ...runtime.context, sessions: harness.sessions };
  const shell = createShellOwner();
  shell.runtime = { ...runtime, context };
  document.body.append(shell.element);
  mountShellView(shell);
  shell.connect();
  await settleShell(shell);
  shell.routeState = { routeId: "chat" };
  shell.activeSessionKey = active.key;
  await vi.dynamicImportSettled();
  await settleShell(shell);
  return { ...harness, shell, context, active, background };
}

describe("OpenClaw shell document title", () => {
  function createShell(options: {
    phase?: ApplicationContext["gateway"]["snapshot"]["phase"];
    approvalCount?: number;
    brandName?: string;
    agentsList?: AgentsListResult | null;
    assistantAgentId?: string;
    environment?: { label: string; color: "amber" };
    sessions?: GatewaySessionRow[] | null;
    activeSessionKey?: string;
  }): ShellDocumentTitleState {
    const previousBranding = currentThemeBranding();
    const branding = resolveThemeBranding({ brandName: options.brandName });
    setCurrentThemeBranding(branding);
    onTestFinished(() => setCurrentThemeBranding(previousBranding));
    const context = {
      gateway: {
        snapshot: {
          phase: options.phase ?? "connected",
          assistantAgentId: options.assistantAgentId ?? null,
        },
        connection: { gatewayUrl: "ws://gateway.test" },
      },
      config: { current: { environment: options.environment ?? null } },
      theme: { branding },
      agents: { state: { agentsList: options.agentsList ?? null } },
      overlays: {
        snapshot: { approvalQueue: Array.from({ length: options.approvalCount ?? 0 }) },
      },
      sessions: {
        presentation: { result: options.sessions ? { sessions: options.sessions } : null },
      },
    } as unknown as ApplicationContext;
    const shell = createShellOwner() as unknown as ShellDocumentTitleState;
    shell.runtime = { context };
    shell.routeState = { routeId: "chat" };
    shell.activeSessionKey = options.activeSessionKey ?? "";
    return shell;
  }

  it("keeps a new tab neutral during connecting", () => {
    const shell = createShell({ phase: "connecting", approvalCount: 2 });
    // Slow initial handshakes are still loading, even after the offline grace period.
    shell.runtime!.context.gateway.snapshot.offlineStable = true;

    expectTitle(shell, "Chat — OpenClaw");
  });

  it.each(["OpenClaw", "Northstar"])(
    "uses %s and the environment in route and custodian titles",
    (brandName) => {
      const shell = createShell({ brandName, environment: { label: "edge", color: "amber" } });
      expectTitle(shell, `Usage — ${brandName} · edge`, "usage");
      expectTitle(shell, `Ask ${brandName} · edge`, "custodian");
    },
  );

  it("updates the active title without rendering the shell for session publications", async () => {
    const { shell, emitEvent, active, background } = await createConnectedSessionShell();
    expect(document.title).toBe("Quarterly launch plan — OpenClaw");
    const renderShell = vi.spyOn(shell, "invalidate");
    for (const session of [
      { ...background, updatedAt: 2, hasActiveRun: true },
      { ...active, updatedAt: 3, derivedTitle: "Revised launch plan" },
    ]) {
      emitEvent({
        type: "event",
        event: "sessions.changed",
        payload: { sessionKey: session.key, reason: "title", session },
      });
      await vi.advanceTimersByTimeAsync(20);
      await settleShell(shell);
    }

    expect(document.title).toBe("Revised launch plan — OpenClaw");
    expect(renderShell).not.toHaveBeenCalled();
  });

  it("retires replaced or disconnected session title observers", async () => {
    const { shell, sessions, context, background } = await createConnectedSessionShell();
    const replacement = createSessionCapabilityHarness(
      vi.fn(async () => sessionsResult([background], 1)) as GatewayBrowserClient["request"],
    );
    await replacement.sessions.refresh({ force: true });
    shell.disconnect();
    shell.runtime = { ...shell.runtime!, context: { ...context, sessions: replacement.sessions } };
    shell.connect();
    document.title = "New context is pending";
    sessions.patchRowLocal(background.key, { derivedTitle: "Retired title" });
    expect(document.title).toBe("New context is pending");
    await settleShell(shell);
    shell.routeState = { routeId: "chat" };
    shell.activeSessionKey = background.key;
    await settleShell(shell);
    replacement.sessions.patchRowLocal(background.key, { derivedTitle: "Replacement title" });
    await vi.advanceTimersByTimeAsync(20);
    await settleShell(shell);
    expect(document.title).toBe("Replacement title — OpenClaw");

    shell.disconnect();
    shell.element.remove();
    await settleShell(shell);
    document.title = "Disconnected shell";
    replacement.sessions.patchRowLocal(background.key, { derivedTitle: "Detached title" });
    await vi.advanceTimersByTimeAsync(20);
    expect(document.title).toBe("Disconnected shell");
  });

  it.each<[Parameters<typeof createShell>[0], string]>([
    [
      {
        assistantAgentId: "molty",
        agentsList: roster([{ id: "molty", name: "Molty" }]),
        activeSessionKey: "global",
      },
      "Molty — OpenClaw",
    ],
    [
      {
        sessions: [sessionRow("agent:missing:main", { label: "Fallback thread" })],
        agentsList: roster([]),
        activeSessionKey: "agent:missing:main",
      },
      "Fallback thread — OpenClaw",
    ],
  ])("resolves chat title %j to %s", (options, title) => {
    expectTitle(createShell(options), title);
  });

  it.each(["reconnecting", "offline", "reload-required"] as const)(
    "keeps the destination title without stale approvals while %s",
    (phase) => {
      const shell = createShell({ phase, approvalCount: 2 });
      expectTitle(shell, "Usage — OpenClaw", "usage");
      shell.runtime!.context.gateway.snapshot.phase = "connected";
      expectTitle(shell, "(2) Usage — OpenClaw");
    },
  );
});
