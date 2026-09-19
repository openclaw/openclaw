/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseApprovalRequestedEvent, type ExecApprovalRequest } from "../app/exec-approval.ts";
import { i18n } from "../i18n/index.ts";
import { renderExecApprovalCard } from "./exec-approval-card.ts";

let container: HTMLDivElement;

function approval(overrides: Partial<ExecApprovalRequest> = {}): ExecApprovalRequest {
  return {
    id: "approval-1",
    kind: "plugin",
    request: {
      command: "Codex approval",
      agentId: "main",
      sessionKey: "agent:main:session-1",
    },
    pluginTitle: "Codex approval",
    pluginDescription: "Command: pnpm test",
    pluginId: "codex",
    createdAtMs: 1,
    expiresAtMs: 61_000,
    ...overrides,
  };
}

function renderCard(request: ExecApprovalRequest, variant: "inline" | "modal" = "modal") {
  render(
    renderExecApprovalCard({
      approval: request,
      busy: false,
      canGrant: true,
      error: null,
      variant,
      onDecision: vi.fn(),
    }),
    container,
  );
  return container.querySelector<HTMLElement>(".exec-approval-card");
}

describe("exec approval card", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    vi.restoreAllMocks();
  });

  it.each([
    ["warn", "warning"],
    ["warning", "warning"],
    ["danger", "danger"],
    ["critical", "danger"],
    ["error", "danger"],
    ["unknown", "info"],
    [undefined, "info"],
  ])("maps plugin severity %s to the %s accent", (pluginSeverity, expected) => {
    const card = renderCard(approval({ pluginSeverity }));

    expect(card?.classList.contains(`exec-approval-card--severity-${expected}`)).toBe(true);
  });

  it("always gives exec approvals the warning accent", () => {
    const card = renderCard(
      approval({
        kind: "exec",
        pluginSeverity: "critical",
        request: { command: "pnpm test" },
      }),
    );

    expect(card?.classList.contains("exec-approval-card--severity-warning")).toBe(true);
  });

  it("shows plugin and agent chips with session details in the modal", () => {
    const card = renderCard(approval());
    const details = card?.querySelector<HTMLDetailsElement>(".exec-approval-details");

    expect(card?.querySelector('[data-approval-chip="plugin"]')?.textContent).toBe("codex");
    expect(card?.querySelector('[data-approval-chip="agent"]')?.textContent).toBe("main");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Session");
    expect(details?.textContent).toContain("agent:main:session-1");
    expect(card?.textContent).not.toContain("Severity");
  });

  it("keeps inline identity limited to the plugin chip", () => {
    const card = renderCard(approval(), "inline");

    expect(card?.querySelector('[data-approval-chip="plugin"]')?.textContent).toBe("codex");
    expect(card?.querySelector('[data-approval-chip="agent"]')).toBeNull();
    expect(card?.querySelector(".exec-approval-details")).toBeNull();
    expect(card?.textContent).not.toContain("agent:main:session-1");
  });

  it.each(["inline", "modal"] as const)(
    "shows the full plugin request detail as plain text in the %s card",
    (variant) => {
      const detail = `  Command: pnpm test\n${"review context\n".repeat(700)}<script>blocked()</script>`;
      const request = parseApprovalRequestedEvent("plugin.approval.requested", {
        id: "plugin-detail",
        request: {
          title: "Review command",
          description: "Run the test suite",
          detail,
        },
        createdAtMs: 1,
        expiresAtMs: 61_000,
      });
      expect(request).not.toBeNull();
      if (!request) {
        throw new Error("Plugin approval event was not parsed");
      }

      const card = renderCard(request, variant);
      const previews = Array.from(card?.querySelectorAll("pre") ?? []);

      expect(previews.map((preview) => preview.textContent)).toEqual([
        "Run the test suite",
        detail,
      ]);
      expect(previews[1]?.closest("details")).toBeNull();
      expect(card?.querySelector("script")).toBeNull();
    },
  );

  it("labels an approval projected from a child session", () => {
    const card = renderCard(approval({ sourceSessionKey: "agent:main:cloud-child" }), "inline");

    expect(card?.textContent).toContain("Approval requested by session cloud-child");
  });

  it("keeps host and cwd visible while collapsing lower-value exec metadata", () => {
    const card = renderCard(
      approval({
        kind: "exec",
        request: {
          command: "pnpm test",
          host: "gateway",
          cwd: "/workspace",
          resolvedPath: "/usr/bin/pnpm",
          security: "allowlist",
          ask: "on-request",
          agentId: "main",
          sessionKey: "agent:main:session-1",
        },
      }),
      "inline",
    );
    const details = card?.querySelector<HTMLDetailsElement>(".exec-approval-details");

    expect(card?.querySelector(".exec-approval-meta")?.textContent).toContain("gateway");
    expect(card?.querySelector(".exec-approval-meta")?.textContent).toContain("/workspace");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Resolved");
    expect(details?.textContent).toContain("Security");
    expect(details?.textContent).toContain("Ask");
    expect(card?.querySelector('[data-approval-chip="agent"]')).toBeNull();
    expect(card?.textContent).not.toContain("agent:main:session-1");
  });
});
