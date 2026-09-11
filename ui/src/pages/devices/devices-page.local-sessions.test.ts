/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSessionEnrollment } from "../../../../packages/gateway-protocol/src/schema/sessions-local.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createInitialDevicesState } from "../../lib/nodes/page-operations.ts";
import "./devices-page.ts";
import type { DevicesRouteData } from "./devices-page.ts";

type TestDevicesPage = HTMLElement & {
  context: ApplicationContext;
  routeData?: DevicesRouteData;
  updateComplete: Promise<boolean>;
};

const source = {
  pluginId: "codex",
  sourceId: "codex",
  label: "Codex",
  command: "sessions.codex.watch",
};
const node = {
  nodeId: "mac-1",
  displayName: "Scott's MacBook",
  paired: true,
  connected: true,
  caps: [],
  commands: ["sessions.codex.watch"],
};

function pendingEnrollment(enrollmentId: string): LocalSessionEnrollment {
  return {
    enrollmentId,
    ownerProfileId: "profile-scott",
    ownerLabel: "Scott",
    deviceId: "mac-1",
    pluginId: "codex",
    sourceId: "codex",
    agentId: "main",
    state: "pending",
    requestedAtMs: 1_000,
    expiresAtMs: Date.now() + 600_000,
  };
}

function mountPage(client: GatewayBrowserClient) {
  const snapshot = {
    client,
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.write"] },
    },
    selfUser: { id: "profile-scott", identity: { type: "profile", id: "profile-scott" } },
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  } as unknown as ApplicationGatewaySnapshot;
  let onEvent: ((event: { event: string; payload?: unknown }) => void) | undefined;
  const gateway = {
    snapshot,
    connection: { gatewayUrl: "http://gateway.test" },
    subscribe: vi.fn(() => () => undefined),
    subscribeEvents: vi.fn((listener: typeof onEvent) => {
      onEvent = listener;
      return () => undefined;
    }),
  } as unknown as ApplicationContext["gateway"];
  const page = document.createElement("openclaw-devices-page") as TestDevicesPage;
  page.routeData = {
    gateway,
    gatewaySnapshot: snapshot,
    devices: createInitialDevicesState({ client, connected: true }),
  };
  page.context = {
    gateway,
    runtimeConfig: {
      state: { configSnapshot: {}, configLoading: false },
      subscribe: vi.fn(() => () => undefined),
      refresh: vi.fn(),
    },
  } as unknown as ApplicationContext;
  document.body.append(page);
  return { page, emit: (event: { event: string; payload?: unknown }) => onEvent?.(event) };
}

function sourceRow(page: HTMLElement): HTMLElement {
  const row = page.querySelector<HTMLElement>('.device-local-session[data-source-id="codex"]');
  if (!row) {
    throw new Error("Expected Codex sharing row");
  }
  return row;
}

function button(scope: Element, label: string): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) {
    throw new Error(`Expected ${label} button`);
  }
  return match;
}

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("DevicesPage live local session sharing", () => {
  it("loads sources and enrollments, enrolls through the Gateway, and follows enrollment events", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      switch (method) {
        case "node.list":
          return { nodes: [node] };
        case "sessions.local.sources":
          return { sources: [source] };
        case "sessions.local.enrollments":
          return { enrollments: [] };
        case "sessions.local.enroll":
          expect(params).toEqual({ deviceId: "mac-1", sourceId: "codex", agentId: "main" });
          return { enrollment: pendingEnrollment("enr-1") };
        case "sessions.local.revoke":
          expect(params).toEqual({ enrollmentId: "enr-1" });
          return { enrollment: { ...pendingEnrollment("enr-1"), state: "revoked" } };
        default:
          return { paired: [], pending: [] };
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { page, emit } = mountPage(client);
    await vi.waitFor(() => expect(sourceRow(page).dataset.state).toBe("none"));
    expect(request).toHaveBeenCalledWith("sessions.local.sources", {}, expect.anything());
    expect(request).toHaveBeenCalledWith("sessions.local.enrollments", {}, expect.anything());

    button(sourceRow(page), "Share Codex sessions").click();
    await vi.waitFor(() => expect(sourceRow(page).dataset.state).toBe("pending"));
    expect(sourceRow(page).querySelector("code")?.textContent).toBe(
      "openclaw sessions share --accept enr-1",
    );

    // The device owner confirmed on the laptop: the broadcast flips the row live.
    emit({
      event: "sessions.local.enrollment",
      payload: { enrollment: { ...pendingEnrollment("enr-1"), state: "active" } },
    });
    await vi.waitFor(() => expect(sourceRow(page).dataset.state).toBe("active"));
    expect(sourceRow(page).textContent).toContain("Shared by Scott with agent main.");

    button(sourceRow(page), "Stop sharing").click();
    await vi.waitFor(() => expect(sourceRow(page).dataset.state).toBe("none"));
    expect(sourceRow(page).textContent).toContain("Last request stopped.");
  });

  it("shows the Gateway's refusal on the device row instead of failing silently", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "node.list":
          return { nodes: [node] };
        case "sessions.local.sources":
          return { sources: [source] };
        case "sessions.local.enrollments":
          return { enrollments: [] };
        case "sessions.local.enroll":
          throw new Error("That device does not offer Codex sessions");
        default:
          return { paired: [], pending: [] };
      }
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { page } = mountPage(client);
    await vi.waitFor(() => expect(sourceRow(page).dataset.state).toBe("none"));
    button(sourceRow(page), "Share Codex sessions").click();
    await vi.waitFor(() =>
      expect(page.querySelector(".device-local-sessions .callout")?.textContent).toContain(
        "That device does not offer Codex sessions",
      ),
    );
    expect(sourceRow(page).dataset.state).toBe("none");
    expect(button(sourceRow(page), "Share Codex sessions").disabled).toBe(false);
  });
});
