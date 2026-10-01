/* @vitest-environment jsdom */

import type { LitElement } from "lit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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

type ShellDocumentTitleState = {
  activeSessionKey: string;
  outboxStoreRuntime: {
    read: () => { total: number };
  } | null;
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
    approvalCount?: number;
    agentsList?: AgentsListResult | null;
    assistantAgentId?: string;
    environment?: { label: string; color: "amber" };
    sessions?: GatewaySessionRow[] | null;
  }): ApplicationContext {
    return {
      gateway: {
        snapshot: {
          phase: (options.connected ?? true) ? "connected" : "reconnecting",
          assistantAgentId: options.assistantAgentId ?? null,
        },
        connection: { gatewayUrl: "ws://gateway.test" },
      },
      config: { current: { environment: options.environment ?? null } },
      agents: { state: { agentsList: options.agentsList ?? null } },
      overlays: {
        snapshot: { approvalQueue: Array.from({ length: options.approvalCount ?? 0 }) },
      },
      sessions: {
        presentation: { result: options.sessions ? { sessions: options.sessions } : null },
      },
    } as unknown as ApplicationContext;
  }

  it("keeps the boot title before a route commits", () => {
    const shell = createShell();
    document.title = "OpenClaw Control";

    shell.routeState = {};
    shell.syncDocumentTitle();
    expect(document.title).toBe("OpenClaw Control");
  });

  it("does not read stored outboxes for a connected document title", () => {
    const shell = createShell(createContext({}));
    const read = vi.fn(() => ({ total: 3 }));
    shell.routeState = { routeId: "usage" };
    shell.outboxStoreRuntime = { read };

    shell.syncDocumentTitle();

    expect(document.title).toBe("Usage — OpenClaw");
    expect(read).not.toHaveBeenCalled();
  });

  it("appends the configured environment to route and custodian titles", () => {
    const shell = createShell(createContext({ environment: { label: "edge", color: "amber" } }));
    shell.routeState = { routeId: "usage" };
    shell.syncDocumentTitle();
    expect(document.title).toBe("Usage — OpenClaw · edge");

    shell.routeState = { routeId: "custodian" };
    shell.syncDocumentTitle();
    expect(document.title).toBe("Ask OpenClaw · edge");
  });

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

    expect(document.title).toBe("(Disconnected) Revised launch plan — OpenClaw");
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
    expect(document.title).toBe("(Disconnected) Replacement title — OpenClaw");

    shell.remove();
    await settleLitElement(shell);
    document.title = "Disconnected shell";
    replacement.sessions.patchRowLocal(background.key, { derivedTitle: "Detached title" });
    await vi.advanceTimersByTimeAsync(20);
    expect(document.title).toBe("Disconnected shell");
  });

  it("uses the agent name for an agent main chat", () => {
    const shell = createShell(
      createContext({ agentsList: roster("main", [{ id: "main", name: "Molty" }]) }),
    );
    shell.routeState = { routeId: "chat" };
    shell.activeSessionKey = "agent:main:main";

    shell.syncDocumentTitle();

    expect(document.title).toBe("Molty — OpenClaw");
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

  it("keeps stored chat outbox counts out of the disconnected marker", () => {
    const shell = createShell(createContext({ connected: false }));
    shell.routeState = { routeId: "usage" };
    shell.outboxStoreRuntime = {
      read: () => ({ total: 3 }),
    };

    shell.syncDocumentTitle();

    expect(document.title).toBe("(Disconnected) Usage — OpenClaw");
  });

  it("uses the meaningful custodian label without a brand suffix", () => {
    const shell = createShell(createContext({}));
    shell.routeState = { routeId: "custodian" };

    shell.syncDocumentTitle();

    expect(document.title).toBe("Ask OpenClaw");
  });
});
