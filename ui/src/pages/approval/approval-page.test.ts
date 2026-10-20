/* @vitest-environment jsdom */

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AllowedApprovalSnapshot,
  ApprovalGetResult,
  ApprovalResolveResult,
  ExpiredApprovalSnapshot,
  PendingApprovalSnapshot,
  PluginApprovalPresentation,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../test-helpers/gateway-client.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import "./approval-page-registration.ts";

type TestApprovalPage = HTMLElement & {
  approvalId: string;
  updateComplete: Promise<boolean>;
};

function pendingApproval(
  overrides: Partial<PendingApprovalSnapshot> = {},
): PendingApprovalSnapshot {
  return {
    id: "exec:approval-1",
    urlPath: "/approve/exec%3Aapproval-1",
    status: "pending",
    createdAtMs: 1_000,
    expiresAtMs: Date.now() + 60_000,
    presentation: {
      kind: "exec",
      commandText: "printf safe",
      commandPreview: "printf …",
      warningText: null,
      host: "gateway",
      nodeId: "runner-1",
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"],
    },
    ...overrides,
  } as PendingApprovalSnapshot;
}

function allowedApproval(): AllowedApprovalSnapshot {
  return {
    ...pendingApproval(),
    status: "allowed",
    decision: "allow-once",
    reason: "user",
    resolvedAtMs: 2_000,
  } as AllowedApprovalSnapshot;
}

function expiredApproval(): ExpiredApprovalSnapshot {
  return {
    ...pendingApproval(),
    status: "expired",
    reason: "timeout",
    resolvedAtMs: 2_000,
  } as ExpiredApprovalSnapshot;
}

function pluginApproval(
  severity: NonNullable<PluginApprovalPresentation["severity"]> = "warning",
): PendingApprovalSnapshot {
  return pendingApproval({
    id: "plugin:approval-1",
    urlPath: "/approve/plugin%3Aapproval-1",
    presentation: {
      kind: "plugin",
      title: "Claude native tool: Bash",
      description: '{"command":"printf …"}',
      detail: '{"command":"printf \\"line one\\nline two\\""}',
      severity,
      pluginId: "claude-cli",
      toolName: "Bash",
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"],
    },
  });
}

async function createPage(
  request: GatewayRequestHandler,
  params: {
    client?: GatewayBrowserClient;
    hello?: ApplicationGatewaySnapshot["hello"];
    id?: string;
  } = {},
) {
  let snapshot: ApplicationGatewaySnapshot = {
    client: params.client ?? ({ request } as GatewayBrowserClient),
    phase: "connected",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello:
      params.hello === undefined
        ? ({ auth: { role: "operator" } } as ApplicationGatewaySnapshot["hello"])
        : params.hello,
    assistantAgentId: "main",
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  const listeners = new Set<(next: ApplicationGatewaySnapshot) => void>();
  const gateway = {
    get snapshot() {
      return snapshot;
    },
    subscribe(listener: (next: ApplicationGatewaySnapshot) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as ApplicationContext["gateway"];
  const source = {
    update(patch: Partial<ApplicationGatewaySnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };

  const page = document.createElement("openclaw-approval-page") as TestApprovalPage;
  const provider = createApplicationContextProvider({
    basePath: "",
    gateway,
  } as unknown as ApplicationContext);
  page.approvalId = params.id ?? "exec:approval-1";
  provider.append(page);
  document.body.append(provider);
  await settle(page);
  return { page, source };
}

function operator(scopes: string[]): ApplicationGatewaySnapshot["hello"] {
  return { auth: { role: "operator", scopes } } as ApplicationGatewaySnapshot["hello"];
}

function decision(page: TestApprovalPage, value = "allow-once") {
  return page.querySelector<HTMLButtonElement>(`[data-decision="${value}"]`)!;
}

function text(page: TestApprovalPage, selector: string) {
  return page.querySelector(selector)?.textContent;
}

function expectRedacted(page: TestApprovalPage, state: string) {
  expect(page.querySelector(".approval-page")?.getAttribute("data-state")).toBe(state);
  expect(page.querySelector(".approval-page__preview")).toBeNull();
  expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
}

function expectReviewOnly(page: TestApprovalPage) {
  expect(text(page, ".approval-page__preview")).toBe("printf safe");
  expect(decision(page).disabled).toBe(true);
  expect(text(page, ".approval-page__heading p")?.trim()).toBe(
    "Review only. Sign in with approval access to record a decision.",
  );
}

async function settle(page: TestApprovalPage) {
  await Promise.resolve();
  await Promise.resolve();
  await page.updateComplete;
}

let visibilityState: DocumentVisibilityState;

beforeEach(async () => {
  await i18n.setLocale("en");
  visibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
});

afterEach(async () => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await i18n.setLocale("en");
});

describe("ApprovalPage", () => {
  it("retires old decisions immediately and looks up only the final native ID", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method !== "approval.get" || !isRecord(params) || typeof params.id !== "string") {
        throw new Error("Expected an approval lookup");
      }
      return { approval: pendingApproval({ id: params.id }) } satisfies ApprovalGetResult;
    });
    const { page } = await createPage(request, { client: createTestGatewayClient(request) });
    await waitForSolid(() => expect(decision(page)).not.toBeNull());
    const oldDecision = decision(page);
    page.approvalId = "exec:approval-2";
    page.approvalId = "exec:approval-3";
    oldDecision.click();
    await settle(page);
    await waitForSolid(() => expect(decision(page)).not.toBeNull());
    expect(request.mock.calls).toEqual([
      ["approval.get", { id: "exec:approval-1" }],
      ["approval.get", { id: "exec:approval-3" }],
    ]);
  });

  it.each([
    {
      kind: "exec",
      scope: {
        kind: "standing-grant",
        automation: "Nightly workspace check",
        command: "printf safe",
        expiresInDays: 14,
      },
      expected:
        'Always allow runs this exact command for "Nightly workspace check" without asking, for 14 days (revocable)',
    },
    {
      kind: "plugin",
      scope: { kind: "payment", amount: "12.34", currency: "USD", target: "Synthetic vendor" },
      expected: "Pays 12.34 USD to Synthetic vendor",
    },
  ] as const)("shows the supplied $kind approval scope before a decision", async (scenario) => {
    const pending = scenario.kind === "exec" ? pendingApproval() : pluginApproval();
    if (pending.presentation.kind === "system-agent") {
      throw new Error("Expected an exec or plugin approval");
    }
    pending.presentation.scope = scenario.scope;
    const request = vi.fn(async () => ({ approval: pending }));
    const { page } = await createPage(request, { id: pending.id });
    expect(page.textContent).toContain(scenario.expected);
    expect(page.textContent).toContain("Waiting for your decision");
  });

  it("keeps a no-auth approval readable without enabling its decisions", async () => {
    const request = vi.fn(
      async (_method: string) => ({ approval: pendingApproval() }) satisfies ApprovalGetResult,
    );
    const { page } = await createPage(request, { hello: null });
    const button = decision(page);
    expect(request).toHaveBeenCalledWith("approval.get", { id: "exec:approval-1" });
    expectReviewOnly(page);
    button.click();
    await settle(page);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([method]) => method === "approval.resolve")).toBe(false);
  });

  it("does not request or disclose a durable approval to an explicitly ungranted operator", async () => {
    const request = vi.fn(async () => ({ approval: pendingApproval() }));
    const { page } = await createPage(request, { hello: operator([]) });
    expect(request).not.toHaveBeenCalled();
    expectRedacted(page, "missing-scope");
    expect(text(page, '[role="alert"]')).toContain("operator.approvals");
  });

  it("rejects an in-flight resolution when only the approval grant is revoked", async () => {
    const { promise: staleDecision, resolve: resolveDecision } =
      Promise.withResolvers<ApprovalResolveResult>();
    const request = vi.fn((method: string): Promise<unknown> =>
      method === "approval.get"
        ? Promise.resolve({ approval: pendingApproval() } satisfies ApprovalGetResult)
        : staleDecision,
    );
    const { page, source } = await createPage(request, { hello: operator(["operator.approvals"]) });
    decision(page).click();
    await page.updateComplete;
    source.update({ hello: null });
    await settle(page);
    expectReviewOnly(page);
    resolveDecision({ applied: true, approval: allowedApproval() });
    await settle(page);
    expect(text(page, ".approval-page__preview")).toBe("printf safe");
    expect(text(page, "h1")).not.toBe("Approved here");
    expect(request.mock.calls.filter(([method]) => method === "approval.resolve")).toHaveLength(1);
  });

  it("redacts a pending approval and rejects a retained action after a scope downgrade", async () => {
    const request = vi.fn(
      async (_method: string) => ({ approval: pendingApproval() }) satisfies ApprovalGetResult,
    );
    const { page, source } = await createPage(request, { hello: operator(["operator.approvals"]) });
    const staleDecision = decision(page);
    source.update({ hello: operator(["operator.read"]) });
    staleDecision.click();
    await settle(page);
    expect(request).toHaveBeenCalledOnce();
    expectRedacted(page, "missing-scope");
    expect(request.mock.calls.some(([method]) => method === "approval.resolve")).toBe(false);
  });

  it("redacts approval details when one snapshot disconnects and revokes access", async () => {
    const request = vi.fn(async () => ({ approval: pendingApproval() }));
    const { page, source } = await createPage(request, { hello: operator(["operator.approvals"]) });
    expect(text(page, ".approval-page__preview")).toBe("printf safe");
    source.update({
      phase: "stopped",
      client: null,
      hello: operator(["operator.read"]),
    });
    await settle(page);
    expectRedacted(page, "connection-error");
    expect(page.textContent).not.toContain("printf safe");
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a pre-revocation lookup when approval access is restored", async () => {
    const { promise: staleLookup, resolve: resolveStale } =
      Promise.withResolvers<ApprovalGetResult>();
    const request = vi
      .fn()
      .mockReturnValueOnce(staleLookup)
      .mockResolvedValueOnce({ approval: allowedApproval() } satisfies ApprovalGetResult);
    const { page, source } = await createPage(request, { hello: operator(["operator.approvals"]) });
    source.update({ hello: operator(["operator.read"]) });
    source.update({ hello: operator(["operator.approvals"]) });
    await settle(page);
    resolveStale({ approval: pendingApproval() });
    await settle(page);
    expect(request).toHaveBeenCalledTimes(2);
    expect(text(page, "h1")).toBe("Approved");
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
  });

  it("loads a durable approval and sends a kind-bound resolution", async () => {
    const pending = pendingApproval();
    const terminal = allowedApproval();
    const request = vi.fn(async (method: string): Promise<unknown> => {
      if (method === "approval.get") {
        return { approval: pending } satisfies ApprovalGetResult;
      }
      return { applied: true, approval: terminal } satisfies ApprovalResolveResult;
    });
    const { page } = await createPage(request);
    expect(request).toHaveBeenCalledWith("approval.get", { id: pending.id });
    expect(text(page, ".approval-page__status")).toContain("Waiting for your decision");
    expect(text(page, ".approval-page__preview")).toBe("printf safe");
    expect(page.querySelector(".approval-page__card--severity-warning")).not.toBeNull();
    expect(text(page, '[data-approval-chip="agent"]')).toBe("main");
    expect(page.querySelector('[data-approval-chip="plugin"]')).toBeNull();
    expect(page.querySelector('[data-approval-chip="tool"]')).toBeNull();
    expect(
      [...page.querySelectorAll(".approval-page__meta-row dt")].map((label) => label.textContent),
    ).toEqual(["Host", "Node"]);
    decision(page).click();
    await settle(page);
    expect(request).toHaveBeenCalledWith("approval.resolve", {
      id: pending.id,
      kind: "exec",
      decision: "allow-once",
    });
    expect(text(page, "h1")).toBe("Approved here");
    expect(document.activeElement).toBe(page.querySelector("h1"));
  });

  it.each([["critical", "danger"]] as const)(
    "maps plugin severity %s to the %s page accent",
    async (severity, expected) => {
      const approval = pluginApproval(severity);
      const request = vi.fn(async () => ({ approval }) satisfies ApprovalGetResult);
      const { page } = await createPage(request, { id: approval.id });

      expect(page.querySelector(`.approval-page__card--severity-${expected}`)).not.toBeNull();
    },
  );

  it("formats approval times with the selected Control UI locale", async () => {
    await i18n.setLocale("de");
    const approval = pendingApproval();
    const request = vi.fn(async () => ({ approval }) satisfies ApprovalGetResult);
    const { page } = await createPage(request);
    const expected = new Intl.DateTimeFormat("de", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(approval.expiresAtMs));
    expect(text(page, "time")?.trim()).toBe(expected);
  });

  it("shows the canonical winner when another surface resolves first", async () => {
    const pending = pendingApproval();
    const terminal = allowedApproval();
    const request = vi.fn(async (method: string): Promise<unknown> =>
      method === "approval.get"
        ? ({ approval: pending } satisfies ApprovalGetResult)
        : ({ applied: false, approval: terminal } satisfies ApprovalResolveResult),
    );
    const { page } = await createPage(request);
    decision(page).click();
    await settle(page);
    expect(text(page, "h1")).toBe("Resolved elsewhere");
    expect(page.textContent).toContain("Another surface or an earlier attempt");
  });

  it("fails closed when the Gateway returns a malformed projection", async () => {
    const request = vi.fn(async () => ({ approval: { status: "pending" } }));
    const { page } = await createPage(request);
    expect(text(page, "h1")).toBe("Approval unavailable");
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
  });

  it("reconciles canonical state when an applied result does not match the submitted decision", async () => {
    const pending = pendingApproval();
    const mismatched = allowedApproval();
    const canonical = expiredApproval();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ approval: pending } satisfies ApprovalGetResult)
      .mockResolvedValueOnce({
        applied: true,
        approval: mismatched,
      } satisfies ApprovalResolveResult)
      .mockResolvedValueOnce({ approval: canonical } satisfies ApprovalGetResult);
    const { page } = await createPage(request);
    decision(page, "deny").click();
    await settle(page);
    expect(request).toHaveBeenCalledTimes(3);
    expect(text(page, "h1")).toBe("Expired");
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
  });

  it("ignores an older lookup after a same-client reconnect", async () => {
    const { promise: first, resolve: resolveFirst } = Promise.withResolvers<ApprovalGetResult>();
    const terminal = allowedApproval();
    const request = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({ approval: terminal } satisfies ApprovalGetResult);
    const { page, source } = await createPage(request);
    source.update({ phase: "reconnecting" });
    source.update({ phase: "connected" });
    await settle(page);
    resolveFirst({ approval: pendingApproval() });
    await settle(page);
    expect(request).toHaveBeenCalledTimes(2);
    expect(text(page, "h1")).toBe("Approved");
    expect(page.querySelectorAll("[data-decision]")).toHaveLength(0);
  });

  it("polls only while the pending document is visible", async () => {
    vi.useFakeTimers();
    const pending = pendingApproval({ expiresAtMs: Date.now() + 60_000 });
    const request = vi.fn(async () => ({ approval: pending }) satisfies ApprovalGetResult);
    const { page } = await createPage(request);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle(page);
    expect(request).toHaveBeenCalledTimes(2);
    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(request).toHaveBeenCalledTimes(2);
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(page);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("keeps one connection alert and disabled decisions across failed background polls", async () => {
    vi.useFakeTimers();
    const pending = pendingApproval({ expiresAtMs: Date.now() + 60_000 });
    const request = vi
      .fn()
      .mockResolvedValueOnce({ approval: pending } satisfies ApprovalGetResult)
      .mockRejectedValue(new Error("temporary Gateway failure"));
    const { page } = await createPage(request);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle(page);
    const alert = page.querySelector(".approval-page__callout");
    expect(alert).not.toBeNull();
    expect(decision(page).disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await settle(page);
    expect(request).toHaveBeenCalledTimes(3);
    expect(page.querySelector(".approval-page__callout")).toBe(alert);
  });

  it("keeps pending context but disables decisions during reconnect", async () => {
    const pending = pendingApproval();
    const request = vi.fn(async () => ({ approval: pending }) satisfies ApprovalGetResult);
    const { page, source } = await createPage(request);
    source.update({ phase: "reconnecting" });
    await page.updateComplete;
    expect(text(page, ".approval-page__preview")).toBe("printf safe");
    expect(decision(page).disabled).toBe(true);
    expect(page.textContent).toContain("Connection interrupted");
  });
});
