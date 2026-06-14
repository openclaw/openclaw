// Proves a real Gateway request for agents.setDefault routes through the lazy
// core method registry to the handler, instead of stopping at "unknown method"
// when the method is missing from the lazy handler family list.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/config.js";
import { handleGatewayRequest } from "./server-methods.js";

const noWebchat = () => false;

function buildClient() {
  return {
    connect: {
      role: "operator",
      scopes: ["operator.admin"],
      client: { id: "openclaw-control-ui", version: "1.0.0", platform: "macos", mode: "ui" },
      minProtocol: 1,
      maxProtocol: 1,
    },
    connId: "conn-1",
    clientIp: "10.0.0.5",
  } as Parameters<typeof handleGatewayRequest>[0]["client"];
}

function buildContext() {
  return {
    logGateway: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    getRuntimeConfig: () => loadConfig(),
  } as unknown as Parameters<typeof handleGatewayRequest>[0]["context"];
}

async function dispatch(method: string, params: Record<string, unknown>) {
  const respond = vi.fn();
  // No extraHandlers: the method must resolve through the real lazy core registry.
  await handleGatewayRequest({
    req: { type: "req", id: "req-1", method, params },
    respond,
    client: buildClient(),
    isWebchatConnect: noWebchat,
    context: buildContext(),
  });
  return respond.mock.calls.at(0) as [boolean, unknown, { code?: string; message?: string }?];
}

describe("agents.setDefault gateway dispatch", () => {
  let home = "";

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-setdefault-dispatch-"));
    process.env.OPENCLAW_HOME = home;
    process.env.OPENCLAW_STATE_DIR = path.join(home, "state");
    process.env.OPENCLAW_CONFIG_PATH = path.join(home, "openclaw.json");
  });

  afterAll(() => {
    delete process.env.OPENCLAW_HOME;
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_CONFIG_PATH;
    fs.rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.writeFileSync(
      process.env.OPENCLAW_CONFIG_PATH as string,
      JSON.stringify({
        agents: {
          list: [
            { id: "main", default: true, workspace: path.join(home, "ws-main") },
            { id: "research", workspace: path.join(home, "ws-research") },
          ],
        },
      }),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("routes a real request to the handler (not unknown-method) and persists the new default", async () => {
    const [ok, result] = await dispatch("agents.setDefault", { agentId: "research" });

    expect(ok).toBe(true);
    expect(result).toEqual({ ok: true, defaultId: "research" });

    const persisted = JSON.parse(
      fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH as string, "utf8"),
    );
    expect(persisted.agents.list).toEqual([
      { id: "main", default: false, workspace: path.join(home, "ws-main") },
      { id: "research", default: true, workspace: path.join(home, "ws-research") },
    ]);
  });

  it("reaches the handler's validator for malformed params (proves wiring, not unknown-method)", async () => {
    const [ok, , error] = await dispatch("agents.setDefault", {});

    expect(ok).toBe(false);
    // The real handler's param validator ran; a missing lazy-list entry would instead
    // surface "unknown method: agents.setDefault".
    expect(error?.message).toContain("invalid agents.setDefault params");
    expect(error?.message).not.toContain("unknown method");
  });

  it("rejects an unknown agent through the full dispatch path without writing config", async () => {
    const [ok, , error] = await dispatch("agents.setDefault", { agentId: "ghost" });

    expect(ok).toBe(false);
    expect(error?.message).toContain('agent "ghost" not found');

    const persisted = JSON.parse(
      fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH as string, "utf8"),
    );
    expect(persisted.agents.list.find((a: { id: string }) => a.id === "main").default).toBe(true);
  });
});
