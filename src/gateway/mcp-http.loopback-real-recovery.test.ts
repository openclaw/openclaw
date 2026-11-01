import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const createdServers = vi.hoisted(() => [] as Server[]);

vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof actual.createServer>) => {
      const server = actual.createServer(...args);
      createdServers.push(server);
      return server;
    },
  };
});

import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { resolveMcpLoopbackClientGrant } from "./mcp-grant-store.js";
import * as mcp from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

const admissions: Array<ReturnType<typeof mcp.prepareAdmission>> = [];
let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "mcp-real-recovery-"));
  setRuntimeConfigSnapshot({
    agents: { defaults: { workspace, skipBootstrap: true } },
    tools: { allow: ["write"], fs: { workspaceOnly: true } },
    plugins: { enabled: false },
  });
});

afterEach(async () => {
  try {
    await closeMcpLoopbackServer();
  } finally {
    admissions.splice(0).forEach((admission) => admission.close());
    clearRuntimeConfigSnapshot();
    await rm(workspace, { recursive: true, force: true });
    createdServers.length = 0;
  }
});

it("recovers a real MCP request after the listener closes unexpectedly", async () => {
  await ensureMcpLoopbackServer();
  const oldRuntime = expectDefined(getActiveMcpLoopbackRuntime(), "old MCP runtime");
  const oldServer = expectDefined(createdServers.at(-1), "old MCP server");
  const admission = mcp.prepareAdmission("mcp-recovery-proof", "mcp-recovery-proof");
  admissions.push(admission);
  const admittedRunContext = await admission.admit("gateway", "gateway-mcp-recovery-proof");
  const oldGrant = mcp.captureGrant(
    {
      context: {
        sessionKey: "agent:main:mcp-recovery-proof",
        senderIsOwner: true,
        workspaceDir: workspace,
        toolsAllow: ["write"],
      },
      runtimeOwnerToken: oldRuntime.ownerToken,
      admittedRunContext,
    },
    "mcp-recovery-proof-capture",
  );
  const capturedAuthority = expectDefined(
    resolveMcpLoopbackClientGrant({ ...oldGrant, runtimeOwnerToken: oldRuntime.ownerToken }),
    "captured client authority",
  );
  expect(capturedAuthority.isCurrent()).toBe(true);

  expect(
    await mcp.json(
      await mcp.request(
        oldRuntime,
        mcp.toolCall("write", {
          path: "before.txt",
          content: "before retirement",
        }),
        oldGrant,
      ),
    ),
  ).toMatchObject({ result: { isError: false } });
  expect(await readFile(path.join(workspace, "before.txt"), "utf8")).toBe("before retirement");

  const closed = once(oldServer, "close");
  oldServer.close();
  await closed;
  expect(getActiveMcpLoopbackRuntime()).toBeUndefined();
  // Check the captured old row directly; a replacement port's token mismatch
  // cannot establish that closing the old listener actually revoked its grant.
  expect(capturedAuthority.isCurrent()).toBe(false);
  expect(
    resolveMcpLoopbackClientGrant({
      ...oldGrant,
      runtimeOwnerToken: oldRuntime.ownerToken,
    }),
  ).toBeUndefined();

  await ensureMcpLoopbackServer();
  const newRuntime = expectDefined(getActiveMcpLoopbackRuntime(), "new MCP runtime");
  const newServer = expectDefined(createdServers.at(-1), "new MCP server");
  expect(newRuntime.ownerToken).not.toBe(oldRuntime.ownerToken);
  expect(newServer).not.toBe(oldServer);

  const retiredGrantResponse = await mcp.request(
    newRuntime,
    mcp.toolCall("write", { path: "retired.txt", content: "must not be written" }),
    oldGrant,
  );
  expect(retiredGrantResponse.status).toBe(401);
  expect(await readdir(workspace)).toEqual(["before.txt"]);

  const successorAdmission = mcp.prepareAdmission("mcp-successor-proof", "mcp-recovery-proof");
  admissions.push(successorAdmission);
  const successorGrant = mcp.captureGrant(
    {
      context: oldGrant.context,
      runtimeOwnerToken: newRuntime.ownerToken,
      admittedRunContext: await successorAdmission.admit("gateway", "gateway-mcp-successor-proof"),
    },
    "mcp-successor-capture",
  );
  expect(
    await mcp.json(
      await mcp.request(
        newRuntime,
        mcp.toolCall("write", {
          path: "successor.txt",
          content: "authorized successor",
        }),
        successorGrant,
      ),
    ),
  ).toMatchObject({ result: { isError: false } });
  expect(await readFile(path.join(workspace, "successor.txt"), "utf8")).toBe(
    "authorized successor",
  );

  expect((await readdir(workspace)).toSorted()).toEqual(["before.txt", "successor.txt"]);
});
