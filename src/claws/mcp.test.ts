import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import * as mcpLease from "../agents/mcp-lifecycle-lease.js";
import { listConfiguredMcpServers, mcpConfigInternal } from "../config/mcp-config.js";
import { closeStateDatabaseForTest as closeState } from "../test-utils/database-cleanup.js";
import {
  installClawMcpServersStateless,
  rollbackStatelessClawMcpServers,
  type PersistedClawMcpServerRef,
} from "./mcp.js";

const SERVER = { command: "uvx", args: ["fixture-mcp"] };

function fixturePlan(ids: string[]) {
  return {
    agent: { finalId: "main" },
    actions: ids.map((id) => ({
      kind: "mcpServer" as const,
      id,
      action: "configure" as const,
      target: `mcp.servers.${id}`,
      details: SERVER,
      blocked: false,
    })),
  };
}

async function installExpectingError(ids = ["fixture"]): Promise<PersistedClawMcpServerRef[]> {
  const refs: PersistedClawMcpServerRef[] = [];
  await expect(installClawMcpServersStateless(fixturePlan(ids), { refs })).rejects.toThrow();
  return refs;
}

async function configured(name: string) {
  const listed = await listConfiguredMcpServers();
  expect(listed.ok).toBe(true);
  return listed.ok ? listed.mcpServers[name] : undefined;
}

function loseAcknowledgementAfterCommit() {
  const realSet = mcpConfigInternal.set;
  vi.spyOn(mcpConfigInternal, "set").mockImplementationOnce(async (params, onCommitted) => {
    await realSet(params, onCommitted);
    throw new Error("config write acknowledgement lost after commit");
  });
}

afterEach(() => vi.restoreAllMocks());

it.aroundEach((run) =>
  withTempHome(
    async () => {
      await closeState();
      try {
        await run();
      } finally {
        await closeState();
      }
    },
    {
      prefix: "openclaw-claw-mcp-write-",
      skipSessionCleanup: true,
      env: {
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_STATE_DIR: (home) => path.join(home, ".openclaw"),
      },
    },
  ),
);

it.each([{ changed: false }, { changed: true }])(
  "reconciles a committed MCP write (changed by another writer: $changed)",
  async ({ changed }) => {
    loseAcknowledgementAfterCommit();
    const refs = await installExpectingError();
    expect(refs).toHaveLength(1);

    if (changed) {
      await mcpConfigInternal.set({
        name: "fixture",
        server: { command: "uvx", args: ["changed-after-failure"] },
      });
    }
    await expect(rollbackStatelessClawMcpServers(refs)).resolves.toEqual([]);
    expect(await configured("fixture")).toEqual(
      changed ? expect.objectContaining({ args: ["changed-after-failure"] }) : undefined,
    );
  },
);

it("drops the ref of an MCP server whose write never committed", async () => {
  vi.spyOn(mcpConfigInternal, "set").mockRejectedValueOnce(new Error("write refused"));

  const refs = await installExpectingError();
  await expect(rollbackStatelessClawMcpServers(refs)).resolves.toEqual([]);
  expect(refs).toEqual([]);
  expect(await configured("fixture")).toBeUndefined();
});

it("keeps an earlier server in refs when a later action cannot start", async () => {
  const withLease = mcpLease.withMcpLifecycleLease;
  vi.spyOn(mcpLease, "withMcpLifecycleLease").mockImplementation((name, options, run) =>
    name === "second" ? Promise.reject(new Error("lease timeout")) : withLease(name, options, run),
  );

  const refs = await installExpectingError(["fixture", "second"]);
  expect(refs).toHaveLength(1);
  await expect(rollbackStatelessClawMcpServers(refs)).resolves.toEqual([]);
  expect(await configured("fixture")).toBeUndefined();
});
