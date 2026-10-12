/* @vitest-environment jsdom */

import type { LitElement } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { resolveThemeBranding } from "../../../packages/gateway-protocol/src/theme.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult, GatewayAgentRow, GatewaySessionRow } from "../api/types.ts";
import type { RouteId } from "../app-routes.ts";
import {
  createSessionCapabilityHarness,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { setupSidebarTest } from "../test-helpers/app-sidebar-setup.ts";
import { settleLitElement } from "../test-helpers/lit-settle.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import "./app-host.ts";
import { bootstrapApplication, type ApplicationRuntime } from "./bootstrap.ts";
import type { ApplicationContext } from "./context.ts";
import { currentThemeBranding, setCurrentThemeBranding } from "./theme-branding.ts";

type ShellDocumentTitleState = {
  activeSessionKey: string;
  routeState: { routeId?: RouteId };
  runtime?: { context: ApplicationContext };
  syncDocumentTitle: () => void;
};

function roster(defaultId: string, agents: GatewayAgentRow[]): AgentsListResult {
  return { defaultId, mainKey: "main", scope: "per-sender", agents };
}

setupSidebarTest();

async function createConnectedSessionShell() {
  vi.useFakeTimers();
  vi.stubGlobal("sessionStorage", createStorageMock());
  vi.stubGlobal("requestIdleCallback", vi.fn());
  const active: GatewaySessionRow = {
    key: "agent:main:quarterly-launch",
    kind: "direct",
    updatedAt: 1,
    derivedTitle: "Quarterly launch plan",
  };
  const background: GatewaySessionRow = {
    key: "agent:main:background-task",
    kind: "direct",
    updatedAt: 1,
  };
  const deletion = createDeferred<{ deleted: boolean }>();
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.delete") {
      return deletion.promise;
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    return sessionsResult([active, background], 1);
  });
  const harness = createSessionCapabilityHarness(request as GatewayBrowserClient["request"]);
  await harness.sessions.refresh({ force: true });
  const runtime = bootstrapApplication();
  const replace = vi.fn();
  const context = { ...runtime.context, sessions: harness.sessions, replace };
  const shell = document.createElement("openclaw-app-shell") as LitElement & {
    runtime: ApplicationRuntime;
    activeSessionKey: string;
    routeState: { routeId?: RouteId };
    render: () => unknown;
  };
  onTestFinished(() => {
    shell.remove();
    runtime.stop();
  });
  shell.runtime = { ...runtime, context };
  document.body.append(shell);
  await settleLitElement(shell);
  shell.routeState = { routeId: "chat" };
  shell.activeSessionKey = active.key;
  await vi.dynamicImportSettled();
  await settleLitElement(shell);
  return { ...harness, shell, context, active, background, deletion, replace };
}

describe("OpenClaw shell document title", () => {
  function createShell(context?: ApplicationContext): ShellDocumentTitleState {
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellDocumentTitleState;
    if (context) {
      shell.runtime = { context };
    }
    return shell;
  }

  function createContext(options: {
    connected?: boolean;
    phase?: ApplicationContext["gateway"]["snapshot"]["phase"];
    approvalCount?: number;
    brandName?: string;
    agentsList?: AgentsListResult | null;
    assistantAgentId?: string;
    environment?: { label: string; color: "amber" };
    sessions?: GatewaySessionRow[] | null;
  }): ApplicationContext {
    const previousBranding = currentThemeBranding();
    const branding = resolveThemeBranding({ brandName: options.brandName });
    setCurrentThemeBranding(branding);
    onTestFinished(() => setCurrentThemeBranding(previousBranding));
    return {
      gateway: {
        snapshot: {
          phase: options.phase ?? ((options.connected ?? true) ? "connected" : "reconnecting"),
          lastError: null,
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
  }

  it("keeps a new tab neutral during connecting", () => {
    const context = createContext({ phase: "connecting", approvalCount: 2 });
    const shell = createShell(context);
    shell.routeState = { routeId: "chat" };
    // Slow initial handshakes are still loading, even after the offline grace period.
    context.gateway.snapshot.offlineStable = true;

    shell.syncDocumentTitle();

    expect(document.title).toBe("Chat — OpenClaw");
  });

  it.each(["OpenClaw", "Northstar"])(
    "uses %s and the environment in route and custodian titles",
    (brandName) => {
      const shell = createShell(
        createContext({ brandName, environment: { label: "edge", color: "amber" } }),
      );
      shell.routeState = { routeId: "usage" };
      shell.syncDocumentTitle();
      expect(document.title).toBe(`Usage — ${brandName} · edge`);

      shell.routeState = { routeId: "custodian" };
      shell.syncDocumentTitle();
      expect(document.title).toBe(`Ask ${brandName} · edge`);
    },
  );

  it("uses the active session's derived title for a non-main chat", () => {
    const session: GatewaySessionRow = {
      key: "agent:main:dashboard:quarterly-launch",
      kind: "direct",
      updatedAt: 1,
      derivedTitle: "Quarterly launch plan",
    };
    const shell = createShell(createContext({ sessions: [session] }));
    shell.routeState = { routeId: "chat" };
    shell.activeSessionKey = session.key;

    shell.syncDocumentTitle();

    expect(document.title).toBe("Quarterly launch plan — OpenClaw");
  });

  it("updates the active title without rendering the shell for session publications", async () => {
    const { shell, emitEvent, active, background } = await createConnectedSessionShell();
    const renderShell = vi.spyOn(shell, "render");
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
      await settleLitElement(shell);
    }

    expect(document.title).toBe("Revised launch plan — OpenClaw");
    expect(renderShell).not.toHaveBeenCalled();
  });

  it("keeps pending deletion recovery and retires replaced or disconnected session observers", async () => {
    const { shell, sessions, context, active, background, deletion, replace } =
      await createConnectedSessionShell();
    const operation = sessions.delete(active.key);
    expect(sessions.deletionState(active.key)).toBe("pending");
    expect(sessions.state.deletedSessions).toEqual([]);
    expect(replace).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat/main" });
    deletion.resolve({ deleted: false });
    await operation;
    await settleLitElement(shell);

    const replacement = createSessionCapabilityHarness(
      vi.fn(async () => sessionsResult([background], 1)) as GatewayBrowserClient["request"],
    );
    await replacement.sessions.refresh({ force: true });
    shell.runtime = { ...shell.runtime, context: { ...context, sessions: replacement.sessions } };
    document.title = "New context is pending";
    sessions.patchRowLocal(background.key, { derivedTitle: "Retired title" });
    expect(document.title).toBe("New context is pending");
    await settleLitElement(shell);
    shell.routeState = { routeId: "chat" };
    shell.activeSessionKey = background.key;
    await settleLitElement(shell);
    replacement.sessions.patchRowLocal(background.key, { derivedTitle: "Replacement title" });
    await vi.advanceTimersByTimeAsync(20);
    await settleLitElement(shell);
    expect(document.title).toBe("Replacement title — OpenClaw");

    shell.remove();
    await settleLitElement(shell);
    document.title = "Disconnected shell";
    replacement.sessions.patchRowLocal(background.key, { derivedTitle: "Detached title" });
    await vi.advanceTimersByTimeAsync(20);
    expect(document.title).toBe("Disconnected shell");
  });

  it("uses the selected agent name for a global-scope main chat", () => {
    const shell = createShell(
      createContext({
        assistantAgentId: "molty",
        agentsList: roster("main", [{ id: "molty", name: "Molty" }]),
      }),
    );
    shell.routeState = { routeId: "chat" };
    shell.activeSessionKey = "global";

    shell.syncDocumentTitle();

    expect(document.title).toBe("Molty — OpenClaw");
  });

  it("falls back to the session display name when the main agent is missing", () => {
    const session: GatewaySessionRow = {
      key: "agent:missing:main",
      kind: "direct",
      updatedAt: 1,
      label: "Fallback thread",
    };
    const shell = createShell(
      createContext({ sessions: [session], agentsList: roster("main", []) }),
    );
    shell.routeState = { routeId: "chat" };
    shell.activeSessionKey = session.key;

    shell.syncDocumentTitle();

    expect(document.title).toBe("Fallback thread — OpenClaw");
  });

  it("prefixes the pending approval count", () => {
    const shell = createShell(createContext({ approvalCount: 2 }));
    shell.routeState = { routeId: "usage" };

    shell.syncDocumentTitle();

    expect(document.title).toBe("(2) Usage — OpenClaw");
  });

  it("shows disconnected instead of a stale approval count", () => {
    const shell = createShell(createContext({ connected: false, approvalCount: 2 }));
    shell.routeState = { routeId: "usage" };

    shell.syncDocumentTitle();

    expect(document.title).toBe("(Disconnected) Usage — OpenClaw");
  });
});
