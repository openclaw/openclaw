/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalSessionEnrollment } from "../../../../packages/gateway-protocol/src/schema/sessions-local.js";
import { i18n } from "../../i18n/index.ts";
import { renderDevicesContainer } from "../../test-helpers/devices-view.ts";
import type { LocalSessionSharingProps } from "./view-local-sessions.ts";

const codexSource = {
  pluginId: "codex",
  sourceId: "codex",
  label: "Codex",
  command: "sessions.codex.watch",
};
const claudeSource = {
  pluginId: "anthropic",
  sourceId: "claude-code",
  label: "Claude Code",
  command: "sessions.claude.watch",
};

function enrollment(overrides: Partial<LocalSessionEnrollment>): LocalSessionEnrollment {
  return {
    enrollmentId: "enr-1",
    ownerProfileId: "profile-scott",
    ownerLabel: "Scott",
    deviceId: "mac-1",
    pluginId: "codex",
    sourceId: "codex",
    agentId: "main",
    state: "pending",
    requestedAtMs: 1_000,
    expiresAtMs: Date.now() + 600_000,
    ...overrides,
  };
}

function localSessions(
  overrides: Partial<LocalSessionSharingProps> = {},
): LocalSessionSharingProps {
  return {
    sources: [codexSource, claudeSource],
    enrollments: [],
    selfProfileId: "profile-scott",
    canWrite: true,
    canAdmin: false,
    selectedAgentByDevice: {},
    busyKey: null,
    error: null,
    onSelectAgent: vi.fn(),
    onShare: vi.fn(),
    onStopSharing: vi.fn(),
    ...overrides,
  };
}

const connectedNode = {
  nodeId: "mac-1",
  displayName: "Scott's MacBook",
  paired: true,
  connected: true,
  caps: [],
  commands: ["system.run", "sessions.codex.watch"],
};

function sourceRow(container: Element, sourceId: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(
    `.device-local-session[data-source-id="${sourceId}"]`,
  );
  if (!row) {
    throw new Error(`Expected ${sourceId} row`);
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
  vi.clearAllMocks();
});

describe("live local session sharing rows", () => {
  it("lists only the sources the connected node advertises and shares with the default agent", () => {
    const props = localSessions();
    const container = renderDevicesContainer({
      nodes: [connectedNode],
      configForm: {
        agents: { entries: { main: { name: "Main" }, review: { default: true } } },
      },
      localSessions: props,
    });
    expect(container.querySelector('[data-source-id="claude-code"]')).toBeNull();
    const row = sourceRow(container, "codex");
    expect(row.dataset.state).toBe("none");
    expect(row.textContent).toContain("Codex sessions");
    expect(row.textContent).toContain("Not shared");
    button(row, "Share Codex sessions").click();
    expect(props.onShare).toHaveBeenCalledExactlyOnceWith("mac-1", "codex", "review");
  });

  it("uses the agent the operator picked for that device", () => {
    const props = localSessions({ selectedAgentByDevice: { "mac-1": "main" } });
    const container = renderDevicesContainer({
      nodes: [connectedNode],
      configForm: { agents: { entries: { main: {}, review: { default: true } } } },
      localSessions: props,
    });
    button(sourceRow(container, "codex"), "Share Codex sessions").click();
    expect(props.onShare).toHaveBeenCalledExactlyOnceWith("mac-1", "codex", "main");
  });

  it("hides the rows for offline or unapproved nodes", () => {
    for (const node of [
      { ...connectedNode, connected: false },
      { ...connectedNode, approvalState: "pending-approval" },
    ]) {
      const container = renderDevicesContainer({ nodes: [node], localSessions: localSessions() });
      expect(container.querySelector(".device-local-session")).toBeNull();
      container.remove();
    }
  });

  it("shows the exact accept command while a request waits on the device", () => {
    const props = localSessions({ enrollments: [enrollment({ enrollmentId: "enr-42" })] });
    const container = renderDevicesContainer({ nodes: [connectedNode], localSessions: props });
    const row = sourceRow(container, "codex");
    expect(row.dataset.state).toBe("pending");
    expect(row.textContent).toContain("Waiting for Scott to confirm on this device.");
    expect(row.querySelector("code")?.textContent).toBe("openclaw sessions share --accept enr-42");
    button(row, "Stop sharing").click();
    expect(props.onStopSharing).toHaveBeenCalledExactlyOnceWith("enr-42");
  });

  it("names the owner of an active share and lets only that owner or an admin stop it", () => {
    const active = enrollment({ enrollmentId: "enr-7", state: "active", confirmedAtMs: 2_000 });
    const owner = renderDevicesContainer({
      nodes: [connectedNode],
      localSessions: localSessions({ enrollments: [active] }),
    });
    const ownerRow = sourceRow(owner, "codex");
    expect(ownerRow.dataset.state).toBe("active");
    expect(ownerRow.textContent).toContain("Shared by Scott with agent main.");
    expect(button(ownerRow, "Stop sharing").disabled).toBe(false);
    owner.remove();

    const teammate = renderDevicesContainer({
      nodes: [connectedNode],
      localSessions: localSessions({ enrollments: [active], selfProfileId: "profile-other" }),
    });
    const teammateButton = button(sourceRow(teammate, "codex"), "Stop sharing");
    expect(teammateButton.disabled).toBe(true);
    expect(teammateButton.title).toBe("Only the sharing person or an admin can stop sharing.");
    teammate.remove();

    const admin = renderDevicesContainer({
      nodes: [connectedNode],
      localSessions: localSessions({
        enrollments: [active],
        selfProfileId: "profile-other",
        canAdmin: true,
      }),
    });
    expect(button(sourceRow(admin, "codex"), "Stop sharing").disabled).toBe(false);
  });

  it("explains why sharing is unavailable and reports the last ended request", () => {
    const declined = enrollment({ state: "declined", reason: "not now", endedAtMs: 3_000 });
    const container = renderDevicesContainer({
      nodes: [connectedNode],
      localSessions: localSessions({
        enrollments: [declined],
        canWrite: false,
        error: { deviceId: "mac-1", message: "enroll failed" },
      }),
    });
    const row = sourceRow(container, "codex");
    expect(row.dataset.state).toBe("none");
    expect(row.textContent).toContain("Last request declined: not now");
    const share = button(row, "Share Codex sessions");
    expect(share.disabled).toBe(true);
    expect(share.title).toBe("Sharing sessions requires operator.write access.");
    expect(container.querySelector(".device-local-sessions .callout")?.textContent).toContain(
      "enroll failed",
    );
  });

  it("prefers an active row over pending and the newest ended request otherwise", () => {
    const rows = [
      enrollment({ enrollmentId: "old", state: "expired", requestedAtMs: 1 }),
      enrollment({ enrollmentId: "pending", state: "pending", requestedAtMs: 2 }),
      enrollment({ enrollmentId: "live", state: "active", requestedAtMs: 0 }),
      enrollment({ enrollmentId: "other-device", state: "active", deviceId: "mac-2" }),
    ];
    const codexRow = (enrollments: LocalSessionEnrollment[]) =>
      sourceRow(
        renderDevicesContainer({
          nodes: [connectedNode],
          localSessions: localSessions({ enrollments }),
        }),
        "codex",
      );
    expect(codexRow(rows).dataset.state).toBe("active");
    expect(codexRow(rows.slice(0, 2)).dataset.state).toBe("pending");
    const ended = codexRow(rows.slice(0, 1));
    expect(ended.dataset.state).toBe("none");
    expect(ended.textContent).toContain("expired");
  });
});
