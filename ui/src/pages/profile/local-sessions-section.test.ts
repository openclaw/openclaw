import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalSessionEnrollment } from "../../../../packages/gateway-protocol/src/index.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import "./local-sessions-section.ts";
import type { ProfileLocalSessions } from "./local-sessions-section.ts";

function enrollment(overrides: Partial<LocalSessionEnrollment> = {}): LocalSessionEnrollment {
  return {
    enrollmentId: "enroll-1",
    ownerProfileId: "profile-scott",
    ownerLabel: "Scott",
    deviceId: "device-abcdef123456",
    pluginId: "codex",
    sourceId: "codex",
    agentId: "main",
    state: "active",
    requestedAtMs: 1_000,
    expiresAtMs: Date.now() + 600_000,
    ...overrides,
  };
}

function mount(request: (method: string, params?: unknown) => Promise<unknown>) {
  const client = createTestGatewayClient(request);
  const snapshot = {
    client,
    phase: "connected",
    hello: {
      type: "hello-ok",
      protocol: 1,
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.local.connectCode", "sessions.local.sources"] },
    },
    selfUser: { id: "profile-scott", identity: { type: "profile", id: "profile-scott" } },
    assistantAgentId: "main",
  } as unknown as ApplicationGatewaySnapshot;
  let onEvent: ((event: { event: string; payload?: unknown }) => void) | undefined;
  // SAFETY: the element's context is a private consumed field; the test injects it directly.
  const element = document.createElement("openclaw-profile-local-sessions") as HTMLElement & {
    context: ApplicationContext;
    requestUpdate: ProfileLocalSessions["requestUpdate"];
  };
  element.context = {
    gateway: {
      snapshot,
      subscribe: vi.fn(() => () => undefined),
      subscribeEvents: vi.fn((listener: typeof onEvent) => {
        onEvent = listener;
        return () => undefined;
      }),
    },
  } as unknown as ApplicationContext;
  document.body.append(element);
  return { element, emit: (event: { event: string; payload?: unknown }) => onEvent?.(event) };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("profile local sessions section", () => {
  it("mints a profile-bound connect command for the selected sources and lists own shares", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const { element, emit } = mount(async (method, params) => {
      calls.push({ method, params });
      switch (method) {
        case "sessions.local.sources":
          return {
            sources: [
              { pluginId: "codex", sourceId: "codex", label: "Codex", command: "c" },
              { pluginId: "anthropic", sourceId: "claude", label: "Claude Code", command: "a" },
            ],
          };
        case "sessions.local.enrollments":
          return {
            enrollments: [
              enrollment(),
              enrollment({ enrollmentId: "other", ownerProfileId: "profile-bob" }),
              enrollment({ enrollmentId: "old", state: "revoked" }),
            ],
          };
        case "sessions.local.connectCode":
          return {
            setupId: "setup-1",
            joinUrl: "https://gateway.test/j/abc",
            command:
              "npx openclaw connect https://gateway.test/j/abc --share codex --share-request setup-1",
            expiresAtMs: Date.now() + 600_000,
            sources: [{ pluginId: "codex", sourceId: "codex", label: "Codex", command: "c" }],
          };
        case "sessions.local.revoke":
          return { enrollment: enrollment({ state: "revoked" }) };
        default:
          throw new Error(`unexpected ${method}`);
      }
    });
    await vi.waitFor(() =>
      expect(element.querySelectorAll('input[type="checkbox"]').length).toBe(2),
    );
    // Only this profile's live share is listed.
    expect(element.querySelectorAll(".profile-local-sessions__enrollment").length).toBe(1);

    const claude = element.querySelector<HTMLInputElement>('input[data-source-id="claude"]');
    claude!.checked = false;
    claude!.dispatchEvent(new Event("change"));
    element.querySelector<HTMLButtonElement>('[data-action="mint"]')!.click();
    await vi.waitFor(() => expect(element.textContent).toContain("--share codex"));
    const mint = calls.find((call) => call.method === "sessions.local.connectCode");
    expect(mint?.params).toEqual({ sourceIds: ["codex"], agentId: "main" });

    element.querySelector<HTMLButtonElement>('[data-action="stop"]')!.click();
    await vi.waitFor(() =>
      expect(element.querySelectorAll(".profile-local-sessions__enrollment").length).toBe(0),
    );
    expect(calls.some((call) => call.method === "sessions.local.revoke")).toBe(true);

    // A live event for a new share of this profile appears without a reload.
    emit({
      event: "sessions.local.enrollment",
      payload: { enrollment: enrollment({ enrollmentId: "enroll-2", state: "pending" }) },
    });
    await vi.waitFor(() =>
      expect(element.querySelectorAll(".profile-local-sessions__enrollment").length).toBe(1),
    );
  });

  it("renders nothing when the Gateway does not offer connect codes", () => {
    const { element } = mount(async () => ({ sources: [], enrollments: [] }));
    const snapshot = element.context.gateway.snapshot as { hello: { features: unknown } };
    snapshot.hello.features = { methods: [] };
    element.requestUpdate();
    expect(element.querySelector("#profile-local-sessions")).toBeNull();
  });
});
