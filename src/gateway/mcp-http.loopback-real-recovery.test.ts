import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import type { Server } from "node:http";
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

import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  resolveMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

const admissions: Array<ReturnType<typeof prepareAdmission>> = [];
let workspace: string;

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    try {
      await closeMcpLoopbackServer();
    } catch (error) {
      // The red baseline retains the callback for the already-closed listener.
      if (!(error instanceof Error && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) {
        throw error;
      }
    } finally {
      admissions.splice(0).forEach((admission) => admission.close());
      clearRuntimeConfigSnapshot();
      createdServers.length = 0;
      cleanup();
    }
  });
});

beforeEach(() => {
  workspace = tempDirs.make("mcp-real-recovery-");
  setRuntimeConfigSnapshot({
    agents: { defaults: { workspace, skipBootstrap: true } },
    tools: { allow: ["write"], fs: { workspaceOnly: true } },
    plugins: { enabled: false },
  });
});

function prepareAdmission(runId: string, boundary: string) {
  return prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: { runId, agentId: "main", ingress: { kind: "system", boundary, state: "present" } },
  });
}

function captureGrant(
  params: Parameters<typeof mintMcpLoopbackClientGrant>[0],
  captureKey: string,
) {
  const grant = mintMcpLoopbackClientGrant(params);
  expect(
    activateMcpLoopbackClientGrantCapture({
      token: grant.token,
      runtimeOwnerToken: params.runtimeOwnerToken,
      captureKey,
    }),
  ).not.toBe(false);
  return { ...grant, captureKey };
}

async function json(response: Response): Promise<unknown> {
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return JSON.parse(body);
}

function request(
  runtime: { port: number },
  message: unknown,
  grant: { token: string; captureKey: string },
) {
  return fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant.token}`,
      "content-type": "application/json",
      "x-openclaw-cli-capture-key": grant.captureKey,
    },
    body: JSON.stringify(message),
  });
}

function toolCall(name: string, args: Record<string, unknown>) {
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } };
}

it("recovers a real MCP request after the listener closes unexpectedly", async () => {
  await ensureMcpLoopbackServer();
  const oldRuntime = expectDefined(getActiveMcpLoopbackRuntime(), "old MCP runtime");
  const oldServer = expectDefined(createdServers.at(-1), "old MCP server");
  const admission = prepareAdmission("mcp-recovery-proof", "mcp-recovery-proof");
  admissions.push(admission);
  const admittedRunContext = await admission.admit("gateway", "gateway-mcp-recovery-proof");
  const oldGrant = captureGrant(
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
    await json(
      await request(
        oldRuntime,
        toolCall("write", {
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

  const retiredGrantResponse = await request(
    newRuntime,
    toolCall("write", { path: "retired.txt", content: "must not be written" }),
    oldGrant,
  );
  expect(retiredGrantResponse.status).toBe(401);
  await retiredGrantResponse.body?.cancel();
  expect(await readdir(workspace)).toEqual(["before.txt"]);

  const successorAdmission = prepareAdmission("mcp-successor-proof", "mcp-recovery-proof");
  admissions.push(successorAdmission);
  const successorGrant = captureGrant(
    {
      context: oldGrant.context,
      runtimeOwnerToken: newRuntime.ownerToken,
      admittedRunContext: await successorAdmission.admit("gateway", "gateway-mcp-successor-proof"),
    },
    "mcp-successor-capture",
  );
  expect(
    await json(
      await request(
        newRuntime,
        toolCall("write", {
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
