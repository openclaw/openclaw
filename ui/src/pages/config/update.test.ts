import { describe, expect, it, vi } from "vitest";
import { runUpdate, type ConfigUpdateState } from "./update.ts";

function createState(): ConfigUpdateState {
  return {
    applySessionKey: "main",
    client: null,
    connected: false,
    lastError: null,
    pendingUpdateExpectedVersion: null,
    pendingUpdateHandoff: false,
    updateRunning: false,
    updateStatusBanner: null,
  };
}

describe("runUpdate", () => {
  it("sends update.run with session key", async () => {
    const request = vi.fn().mockResolvedValue({});
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigUpdateState["client"];
    state.applySessionKey = "agent:main:whatsapp:dm:+15555550123";

    await runUpdate(state);

    expect(request).toHaveBeenCalledWith("update.run", {
      sessionKey: "agent:main:whatsapp:dm:+15555550123",
    });
  });

  it("surfaces update errors returned in response payload", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false,
      result: { status: "error", reason: "network unavailable" },
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigUpdateState["client"];

    await runUpdate(state);

    expect(state.updateStatusBanner).toEqual({
      tone: "danger",
      text: "Update error: network unavailable. See the gateway logs for the exact failure and retry once the cause is fixed.",
    });
  });

  it("surfaces skipped updates with actionable guidance", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false,
      result: { status: "skipped", reason: "dirty" },
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigUpdateState["client"];

    await runUpdate(state);

    expect(state.updateStatusBanner).toEqual({
      tone: "warn",
      text: "Update skipped: dirty. Commit or stash changes, then retry.",
    });
  });

  it("surfaces managed-service handoff command when the gateway cannot start it", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: false,
      result: { status: "skipped", reason: "managed-service-handoff-unavailable" },
      handoff: {
        status: "unavailable",
        command: "openclaw update --yes",
        message:
          "OpenClaw updates cannot safely run inside the live gateway process without a managed-service handoff.",
      },
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigUpdateState["client"];

    await runUpdate(state);

    expect(state.updateStatusBanner).toEqual({
      tone: "warn",
      text: "Update skipped: managed-service-handoff-unavailable. Run `openclaw update --yes` from a shell outside the Gateway process.",
    });
  });

  it("stores the expected post-update version when update.run succeeds", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        status: "ok",
        after: { version: "2.0.0" },
      },
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigUpdateState["client"];

    await runUpdate(state);

    expect(state.pendingUpdateExpectedVersion).toBe("2.0.0");
    expect(state.pendingUpdateHandoff).toBe(false);
    expect(state.updateStatusBanner).toBeNull();
  });

  it("tracks managed-service handoff updates for reconnect verification", async () => {
    const request = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        status: "skipped",
        reason: "managed-service-handoff-started",
      },
      handoff: { status: "started" },
    });
    const state = createState();
    state.connected = true;
    state.client = { request } as unknown as ConfigUpdateState["client"];

    await runUpdate(state);

    expect(state.pendingUpdateExpectedVersion).toBeNull();
    expect(state.pendingUpdateHandoff).toBe(true);
    expect(state.updateStatusBanner).toBeNull();
  });
});
