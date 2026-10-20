/* @vitest-environment jsdom */

import { createComponent } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseApprovalRequestedEvent,
  resolveApprovalRequest,
  type ExecApprovalDecision,
  type ExecApprovalRequest,
} from "../app/exec-approval.ts";
import { i18n } from "../i18n/index.ts";
import { projectSessionApprovalReplay } from "../pages/chat/session-approval-projection.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import {
  ExecApprovalCard,
  SidebarApprovalRow,
  type ExecApprovalCardProps,
} from "./exec-approval-card-solid.tsx";

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

function plugin(request: Record<string, unknown>, live = false) {
  const now = live ? Date.now() : 1;
  const result = parseApprovalRequestedEvent("plugin.approval.requested", {
    id: "plugin",
    request,
    createdAtMs: now,
    expiresAtMs: now + 60_000,
  });
  expect(result).not.toBeNull();
  if (!result) {
    throw new Error("Plugin approval event was not parsed");
  }
  return result;
}

function renderSurface(
  request: ExecApprovalRequest,
  variant: "inline" | "modal" | "sidebar" = "modal",
  onDecision: ExecApprovalCardProps["onDecision"] = vi.fn(),
) {
  const props = { approval: request, busy: false, connected: true, canGrant: true, error: null };
  const view = mountSolid(
    () =>
      variant === "sidebar"
        ? createComponent(SidebarApprovalRow, {
            ...props,
            onDecision: (_event, id, decision) => void onDecision(id, decision),
          })
        : createComponent(ExecApprovalCard, { props: { ...props, variant, onDecision } }),
    { container },
  );
  return { ...view, card: container.querySelector<HTMLElement>(".exec-approval-card") };
}

function renderCard(request: ExecApprovalRequest, variant: "inline" | "modal" = "modal") {
  return renderSurface(request, variant).card;
}

describe("exec approval card", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    container = document.createElement("div");
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("maps plugin error severity to the danger accent", () => {
    const card = renderCard(approval({ pluginSeverity: "error" }));
    expect(card?.classList.contains("exec-approval-card--severity-danger")).toBe(true);
  });

  it.each(["add", "update"] as const)(
    "presents a native %s watcher proposal without hiding execution details",
    (operation) => {
      const request = parseApprovalRequestedEvent("exec.approval.requested", {
        id: "stream-approval",
        createdAtMs: 1,
        expiresAtMs: 61_000,
        request: {
          command: "tail -F app.log",
          host: "sandbox",
          ask: "always",
          warningText: "Runs after this turn and restarts automatically until stopped.",
          allowedDecisions: ["allow-once", "deny"],
          streamProposal: { jobId: "watcher-1", name: "Watch application errors", operation },
        },
      });
      expect(request).not.toBeNull();
      const card = renderCard(request!);
      expect(card?.querySelector(".exec-approval-title")?.textContent).toBe(
        "Watch application errors",
      );
      expect(card?.querySelector(".exec-approval-command")?.textContent).toBe("tail -F app.log");
      expect(card?.textContent).toContain(
        "Runs after this turn and restarts automatically until stopped.",
      );
      expect(card?.querySelector(".exec-approval-summary")?.textContent).toContain(
        "Runs in your sandbox after you leave this chat, until stopped.",
      );
      expect(card?.textContent).toContain(
        operation === "add" ? "Start watching" : "Save watcher change",
      );
      expect(card?.textContent).toContain("Cancel");
      expect(card?.textContent).not.toContain("Approved by you");
    },
  );

  it.each(["live exec event", "session replay"])(
    "shows the full exec warning before decisions from %s",
    (transport) => {
      const warningText =
        'Create persistent stream "Log watcher"? It keeps running after this conversation ends. ' +
        "Approve once authorizes this saved watcher and its automatic restarts until disabled or deleted. " +
        'Each output starts the task "Summarize <script>logs</script>".';
      const command = "/usr/bin/python3 /workspace/watch-logs.py";
      const sessionKey = "agent:main:session-1";
      const allowedDecisions = ["allow-once", "deny"] as const;
      const common = {
        id: "cron-stream:warning",
        createdAtMs: 1,
        expiresAtMs: Date.now() + 60_000,
      };
      const request =
        transport === "live exec event"
          ? parseApprovalRequestedEvent("exec.approval.requested", {
              ...common,
              request: { command, sessionKey, warningText, allowedDecisions },
            })
          : projectSessionApprovalReplay(
              {
                sessionKey,
                updatedAtMs: 2,
                truncated: false,
                approvals: [
                  {
                    ...common,
                    status: "pending",
                    urlPath: "/approve/cron-stream%3Awarning",
                    presentation: {
                      kind: "exec",
                      commandText: command,
                      warningText,
                      allowedDecisions,
                    },
                  },
                ],
              },
              sessionKey,
            )[0];
      if (!request) {
        throw new Error("Exec approval was not parsed");
      }

      for (const surface of ["inline", "sidebar"] as const) {
        const view = mountSolid(
          () =>
            surface === "inline"
              ? createComponent(ExecApprovalCard, {
                  props: {
                    approval: request,
                    connected: true,
                    busy: false,
                    canGrant: true,
                    error: null,
                    variant: "inline",
                    onDecision: vi.fn(),
                  },
                })
              : createComponent(SidebarApprovalRow, {
                  approval: request,
                  connected: true,
                  busy: false,
                  canGrant: true,
                  error: null,
                  onDecision: vi.fn(),
                }),
          { container },
        );
        try {
          const note = Array.from(container.querySelectorAll('[role="note"]')).find(
            (element) => element.textContent?.trim() === warningText,
          );
          const buttons = Array.from(container.querySelectorAll("button"));
          expect(note, surface).toBeDefined();
          expect(note?.closest("details")).toBeNull();
          expect(container.querySelector("script")).toBeNull();
          expect(buttons.map((button) => button.textContent?.trim())).toEqual([
            "Allow once",
            "Deny",
          ]);
          expect(
            Boolean(
              note &&
              buttons[0] &&
              note.compareDocumentPosition(buttons[0]) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
            surface,
          ).toBe(true);
        } finally {
          view.unmount();
        }
      }
    },
  );

  it("expires a mounted sidebar approval and disables its decisions", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(0);
    const onDecision = vi.fn();
    const view = renderSurface(approval({ expiresAtMs: 2_000 }), "sidebar", onDecision);
    const timer = view.getByRole("timer");
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons).toHaveLength(3);
    expect(timer.getAttribute("aria-label")).toBe("expires in 00:02");
    expect(buttons.every((button) => !button.disabled)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    flush();
    expect(timer).toMatchObject({ textContent: "00:00", title: "expired" });
    expect(timer.getAttribute("aria-label")).toBe("expired");
    expect(buttons.every((button) => button.disabled)).toBe(true);
    for (const button of buttons) {
      button.click();
    }
    expect(onDecision).not.toHaveBeenCalled();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves command text while highlighting ordered, non-overlapping valid spans", () => {
    const command = "echo hello | cat";
    const card = renderCard(
      approval({
        kind: "exec",
        request: {
          command,
          commandSpans: [
            { startIndex: 13, endIndex: 16 },
            { startIndex: 0, endIndex: 2 },
            { startIndex: 0, endIndex: 4 },
            { startIndex: 3, endIndex: 7 },
            { startIndex: 5, endIndex: 10 },
            { startIndex: -1, endIndex: 1 },
            { startIndex: 11, endIndex: 11 },
            { startIndex: 12, endIndex: 99 },
          ],
        },
      }),
    );
    expect(card?.querySelector(".exec-approval-command")?.textContent).toBe(command);
    expect(Array.from(card?.querySelectorAll("mark") ?? [], (mark) => mark.textContent)).toEqual([
      "echo",
      "hello",
      "cat",
    ]);
  });

  it.each(["modal", "sidebar"] as const)(
    "uses plugin decision action labels and resolves their original decisions in the %s surface",
    async (variant) => {
      const request = plugin(
        {
          title: "Allow parts.search?",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
          actions: [
            { kind: "decision", decision: "allow-once", label: "Allow once", command: "" },
            {
              kind: "decision",
              decision: "allow-always",
              label: "Allow while this App is open",
              command: "",
            },
            { kind: "command", decision: "deny", label: "Run a command", command: "status" },
            { kind: "decision", decision: "deny", label: "Deny", command: "" },
          ],
        },
        true,
      );
      const client = { request: vi.fn(async () => ({})) };
      const onDecision = vi.fn((id: string, decision: ExecApprovalDecision) => {
        expect(id).toBe(request.id);
        return resolveApprovalRequest(client, request, decision);
      });
      renderSurface(request, variant, onDecision);
      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        "Allow once",
        "Allow while this App is open",
        "Deny",
      ]);
      for (const button of buttons) {
        button.click();
      }
      await Promise.all(onDecision.mock.results.map((result) => result.value));
      expect(client.request.mock.calls).toEqual([
        ["plugin.approval.resolve", { id: request.id, decision: "allow-once" }],
        ["plugin.approval.resolve", { id: request.id, decision: "allow-always" }],
        ["plugin.approval.resolve", { id: request.id, decision: "deny" }],
      ]);
    },
  );

  it("shows the full plugin request detail as plain text in the modal card", () => {
    const detail = `  Command: pnpm test\n${"review context\n".repeat(700)}<script>blocked()</script>`;
    const request = plugin({ title: "Review command", description: "Run the test suite", detail });
    const card = renderCard(request);
    const previews = Array.from(card?.querySelectorAll("pre") ?? []);
    expect(previews.map((preview) => preview.textContent)).toEqual(["Run the test suite", detail]);
    expect(previews[1]?.closest("details")).toBeNull();
    expect(card?.querySelector("script")).toBeNull();
  });

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
