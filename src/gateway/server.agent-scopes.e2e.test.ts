import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ErrorCodes } from "./protocol/index.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function openWs(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve) => ws.once("open", resolve));
  return ws;
}

async function ensureHackathonAgent(ws: WebSocket) {
  const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-hackathon-"));
  const res = await rpcReq(ws, "agents.create", {
    name: "hackathon",
    workspace: tmpWorkspace,
  });
  // If it already exists (shouldn't with suite isolation), allow tests to proceed.
  if (!res.ok && !(res.error?.message ?? "").includes("already exists")) {
    throw new Error(`failed to create hackathon agent: ${res.error?.message ?? "unknown error"}`);
  }
}

describe("gateway agent scopes", () => {
  it('filters agents.list when scopes=["agents:hackathon"]', async () => {
    const { server, ws, port } = await startServerWithClient();
    await connectOk(ws);
    await ensureHackathonAgent(ws);

    const wsCollab = await openWs(port);
    await connectOk(wsCollab, { role: "collaborator", scopes: ["agents:hackathon"] });
    const res = await rpcReq<{ agents: Array<{ id: string }> }>(wsCollab, "agents.list", {});
    expect(res.ok).toBe(true);
    expect(res.payload?.agents.map((a) => a.id)).toEqual(["hackathon"]);
    wsCollab.close();
    ws.close();
    await server.close();
  });

  it("treats empty agent scopes as full access (backward compat)", async () => {
    const { server, ws, port } = await startServerWithClient();
    await connectOk(ws);
    await ensureHackathonAgent(ws);

    const wsCollab = await openWs(port);
    await connectOk(wsCollab, { role: "collaborator", scopes: [] });
    const res = await rpcReq<{ agents: Array<{ id: string }> }>(wsCollab, "agents.list", {});
    expect(res.ok).toBe(true);
    const ids = res.payload?.agents.map((a) => a.id) ?? [];
    expect(ids).toContain("main");
    expect(ids).toContain("hackathon");
    wsCollab.close();
    ws.close();
    await server.close();
  });

  it("prevents collaborators from calling agents.create", async () => {
    const { server, ws, port } = await startServerWithClient();
    ws.close();
    await new Promise<void>((resolve) => ws.once("close", () => resolve()));

    const wsCollab = await openWs(port);
    await connectOk(wsCollab, { role: "collaborator", scopes: ["agents:hackathon"] });
    const tmpWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-collab-create-"));
    const res = await rpcReq(wsCollab, "agents.create", {
      name: "collab-create-should-fail",
      workspace: tmpWorkspace,
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
    wsCollab.close();
    await server.close();
  });

  it("prevents collaborators from accessing files for out-of-scope agents", async () => {
    const { server, ws, port } = await startServerWithClient();
    await connectOk(ws);
    await ensureHackathonAgent(ws);

    const wsCollab = await openWs(port);
    await connectOk(wsCollab, { role: "collaborator", scopes: ["agents:hackathon"] });
    const res = await rpcReq(wsCollab, "agents.files.list", { agentId: "main" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe(ErrorCodes.FORBIDDEN);
    wsCollab.close();
    ws.close();
    await server.close();
  });
});
