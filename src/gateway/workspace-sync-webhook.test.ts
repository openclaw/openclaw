import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as syncModule from "../agents/workspace-sync.js";
import * as configModule from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { handleWorkspaceSyncWebhook } from "./workspace-sync-webhook.js";

function createMockRequest(headers: Record<string, string> = {}) {
  return {
    headers,
  } as unknown as IncomingMessage;
}

function createMockResponse() {
  const setHeader = vi.fn();
  const end = vi.fn();
  const res = {
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return { res, setHeader, end };
}

describe("Workspace Sync Webhook Handler", () => {
  beforeEach(() => {
    vi.spyOn(configModule, "loadConfig").mockReturnValue({} as unknown as OpenClawConfig);
    vi.spyOn(syncModule, "pullAndApplyWorkspaceSync").mockResolvedValue({
      ok: true,
      filesUpdated: ["SOUL.md"],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 403 if feature is disabled", async () => {
    vi.mocked(configModule.loadConfig).mockReturnValue({
      agents: { defaults: { workspaceSync: { enabled: false } } },
    } as unknown as OpenClawConfig);

    const req = createMockRequest();
    const { res, end } = createMockResponse();

    const handled = await handleWorkspaceSyncWebhook(req, res, []);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(403);
    expect(end).toHaveBeenCalledWith(expect.stringMatching(/disabled/));
  });

  it("returns 403 if webhook is disabled", async () => {
    vi.mocked(configModule.loadConfig).mockReturnValue({
      agents: { defaults: { workspaceSync: { enabled: true, webhook: { enabled: false } } } },
    } as unknown as OpenClawConfig);

    const req = createMockRequest();
    const { res, end } = createMockResponse();

    await handleWorkspaceSyncWebhook(req, res, []);

    expect(res.statusCode).toBe(403);
    expect(end).toHaveBeenCalledWith(expect.stringMatching(/webhook is disabled/));
  });

  it("returns 401 if token is missing", async () => {
    vi.mocked(configModule.loadConfig).mockReturnValue({
      agents: {
        defaults: { workspaceSync: { enabled: true, webhook: { enabled: true, token: "secret" } } },
      },
    } as unknown as OpenClawConfig);

    const req = createMockRequest({}); // NO headers
    const { res } = createMockResponse();

    await handleWorkspaceSyncWebhook(req, res, []);

    expect(res.statusCode).toBe(401);
  });

  it("returns 401 if token is invalid", async () => {
    vi.mocked(configModule.loadConfig).mockReturnValue({
      agents: {
        defaults: { workspaceSync: { enabled: true, webhook: { enabled: true, token: "secret" } } },
      },
    } as unknown as OpenClawConfig);

    const req = createMockRequest({ authorization: "Bearer wrong" });
    const { res } = createMockResponse();

    await handleWorkspaceSyncWebhook(req, res, []);

    expect(res.statusCode).toBe(401);
  });

  it("authenticates via specific webhook token", async () => {
    vi.mocked(configModule.loadConfig).mockReturnValue({
      agents: {
        defaults: {
          workspaceSync: { enabled: true, webhook: { enabled: true, token: "specific-secret" } },
        },
      },
    } as unknown as OpenClawConfig);

    const req = createMockRequest({ authorization: "Bearer specific-secret" });
    const { res } = createMockResponse();

    await handleWorkspaceSyncWebhook(req, res, []);

    expect(res.statusCode).toBe(200);
    expect(syncModule.pullAndApplyWorkspaceSync).toHaveBeenCalledTimes(1);
  });

  it("authenticates via global hooks token fallback", async () => {
    vi.mocked(configModule.loadConfig).mockReturnValue({
      hooks: { token: "global-secret" },
      agents: { defaults: { workspaceSync: { enabled: true, webhook: { enabled: true } } } },
    } as unknown as OpenClawConfig);

    const req = createMockRequest({ authorization: "Bearer global-secret" });
    const { res } = createMockResponse();

    await handleWorkspaceSyncWebhook(req, res, []);

    expect(res.statusCode).toBe(200);
    expect(syncModule.pullAndApplyWorkspaceSync).toHaveBeenCalledTimes(1);
  });

  it("handles sync errors properly (returns 500)", async () => {
    vi.mocked(configModule.loadConfig).mockReturnValue({
      agents: {
        defaults: { workspaceSync: { enabled: true, webhook: { enabled: true, token: "secret" } } },
      },
    } as unknown as OpenClawConfig);
    vi.mocked(syncModule.pullAndApplyWorkspaceSync).mockResolvedValueOnce({
      ok: false,
      filesUpdated: [],
      error: "Network Down",
    });

    const req = createMockRequest({ authorization: "Bearer secret" });
    const { res, end } = createMockResponse();

    await handleWorkspaceSyncWebhook(req, res, []);

    expect(res.statusCode).toBe(500);
    expect(end).toHaveBeenCalledWith(expect.stringMatching(/Network Down/));
  });
});
