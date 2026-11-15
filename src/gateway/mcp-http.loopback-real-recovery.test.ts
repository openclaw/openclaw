import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mintCliMcpClientGrant } from "../agents/cli-runner/mcp-client-grant.js";
import {
  resolveFileMutationQueueKey,
  withFileMutationQueueKeyResolution,
} from "../agents/sessions/tools/file-mutation-queue.js";
import { createDeferredCore } from "../shared/deferred.js";

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
import {
  activateMcpLoopbackClientGrantCapture,
  resolveMcpLoopbackClientGrant,
  transferMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import * as mcp from "./mcp-http-request.test-support.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import {
  beginMcpLoopbackToolCallCapture,
  clearMcpLoopbackToolCallCapture,
  getActiveMcpLoopbackRuntime,
} from "./mcp-http.loopback-runtime.js";

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

it("fences retired warm-turn writes while preserving the successor's bearer", async () => {
  await ensureMcpLoopbackServer();
  const runtime = mcp.runtime();
  const turns: Array<Awaited<ReturnType<typeof mintCliMcpClientGrant>>> = [];
  const holders: Promise<void>[] = [];
  const requests: Promise<unknown>[] = [];
  const captureKey = "mcp-warm-turn-effects";
  const retiredTarget = path.join(workspace, "retired.txt");
  const successorTarget = path.join(workspace, "successor.txt");
  const retiredPrepared = createDeferredCore();
  const successorPrepared = createDeferredCore();
  const releaseRetired = createDeferredCore();
  const releaseSuccessor = createDeferredCore();
  const mintTurn = async (runId: string) => {
    const admission = mcp.prepareAdmission(runId, "mcp-warm-turn-effects");
    admissions.push(admission);
    const turn = await mintCliMcpClientGrant({ sessionId: runId }, "main", {
      runtimeOwnerToken: runtime.ownerToken,
      admittedRunContext: await admission.admit("gateway", runId),
      context: {
        sessionKey: "agent:main:mcp-warm-turn-effects",
        runId,
        senderIsOwner: true,
        workspaceDir: workspace,
        toolsAllow: ["write"],
      },
    });
    turns.push(turn);
    return turn;
  };
  const activate = (token: string) => {
    expect(
      activateMcpLoopbackClientGrantCapture({
        token,
        runtimeOwnerToken: runtime.ownerToken,
        captureKey,
      }),
    ).toBeTruthy();
  };
  try {
    const first = await mintTurn("mcp-warm-first");
    const bearerToken = first.grant.token;
    const httpGrant = { token: bearerToken, captureKey };
    const write = (name: string, content: string) =>
      mcp.request(
        runtime,
        mcp.toolCall("write", { path: path.join(workspace, name), content }),
        httpGrant,
      );
    activate(bearerToken);
    expect(await mcp.json(await write("first.txt", "first turn"))).toMatchObject({
      result: { isError: false },
    });

    const second = await mintTurn("mcp-warm-second");
    expect(
      transferMcpLoopbackClientGrant({
        sourceToken: second.grant.token,
        targetToken: bearerToken,
        runtimeOwnerToken: runtime.ownerToken,
      }),
    ).toBe(true);
    activate(bearerToken);
    expect(await mcp.json(await write("second.txt", "second turn"))).toMatchObject({
      result: { isError: false },
    });
    expect(await readFile(path.join(workspace, "second.txt"), "utf8")).toBe("second turn");

    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallUpdate: ({ current }) => {
        if (current.args.path === retiredTarget) {
          retiredPrepared.resolve();
        } else if (current.args.path === successorTarget) {
          successorPrepared.resolve();
        }
      },
      onToolCallResult: () => {},
    });
    // Both writes wait after dispatch, so their source guards observe the handoff.
    holders.push(
      withFileMutationQueueKeyResolution(
        resolveFileMutationQueueKey(retiredTarget),
        () => releaseRetired.promise,
      ),
    );
    const retired = write("retired.txt", "must not be written").then(mcp.json);
    requests.push(retired);
    expect(
      await Promise.race([retiredPrepared.promise.then(() => true), retired.then(() => false)]),
    ).toBe(true);
    await second.cleanup();
    expect((await write("replayed.txt", "must not be written")).status).toBe(401);

    const third = await mintTurn("mcp-warm-third");
    expect(
      transferMcpLoopbackClientGrant({
        sourceToken: third.grant.token,
        targetToken: bearerToken,
        runtimeOwnerToken: runtime.ownerToken,
      }),
    ).toBe(true);
    activate(bearerToken);
    holders.push(
      withFileMutationQueueKeyResolution(
        resolveFileMutationQueueKey(successorTarget),
        () => releaseSuccessor.promise,
      ),
    );
    const successor = write("successor.txt", "successor turn").then(mcp.json);
    requests.push(successor);
    expect(
      await Promise.race([successorPrepared.promise.then(() => true), successor.then(() => false)]),
    ).toBe(true);
    // This is the predecessor's first cleanup, while the same bearer serves C.
    await first.cleanup();
    releaseSuccessor.resolve();
    expect(await successor).toMatchObject({ result: { isError: false } });
    expect(await readFile(successorTarget, "utf8")).toBe("successor turn");

    releaseRetired.resolve();
    expect(await retired).toMatchObject({
      result: {
        isError: true,
        content: [
          { text: expect.stringContaining("tool invocation authority is no longer active") },
        ],
      },
    });
    expect(await readFile(path.join(workspace, "first.txt"), "utf8")).toBe("first turn");
    expect((await readdir(workspace)).toSorted()).toEqual([
      "first.txt",
      "second.txt",
      "successor.txt",
    ]);
  } finally {
    try {
      await Promise.all(turns.map((turn) => turn.cleanup()));
    } finally {
      releaseRetired.resolve();
      releaseSuccessor.resolve();
      await Promise.allSettled([...holders, ...requests]);
      clearMcpLoopbackToolCallCapture(captureKey);
    }
  }
});
