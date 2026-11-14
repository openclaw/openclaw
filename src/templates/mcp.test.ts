import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import * as mcpLease from "../agents/mcp-lifecycle-lease.js";
import { listConfiguredMcpServers, mcpConfigInternal } from "../config/mcp-config.js";
import { closeStateDatabaseForTest as closeState } from "../test-utils/database-cleanup.js";
import {
  installTemplateMcpServersStateless,
  rollbackStatelessTemplateMcpServers,
  type PersistedTemplateMcpServerRef,
} from "./mcp.js";

const SERVER = { command: "uvx", args: ["fixture-mcp"] };
const SERVER_WITH_TIMEOUTS = { ...SERVER, requestTimeoutMs: 30_000, connectionTimeoutMs: 5_000 };

function fixturePlan(ids: string[], details: Record<string, unknown> = SERVER) {
  return {
    agent: { finalId: "main" },
    actions: ids.map((id) => ({
      kind: "mcpServer" as const,
      id,
      action: "configure" as const,
      target: `mcp.servers.${id}`,
      details,
      blocked: false,
    })),
  };
}

async function installExpectingError(ids = ["fixture"]): Promise<PersistedTemplateMcpServerRef[]> {
  const refs: PersistedTemplateMcpServerRef[] = [];
  await expect(installTemplateMcpServersStateless(fixturePlan(ids), { refs })).rejects.toThrow();
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
      prefix: "openclaw-template-mcp-write-",
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
    await expect(rollbackStatelessTemplateMcpServers(refs)).resolves.toEqual([]);
    expect(await configured("fixture")).toEqual(
      changed ? expect.objectContaining({ args: ["changed-after-failure"] }) : undefined,
    );
  },
);

it("drops the ref of an MCP server whose write never committed", async () => {
  vi.spyOn(mcpConfigInternal, "set").mockRejectedValueOnce(new Error("write refused"));

  const refs = await installExpectingError();
  await expect(rollbackStatelessTemplateMcpServers(refs)).resolves.toEqual([]);
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
  await expect(rollbackStatelessTemplateMcpServers(refs)).resolves.toEqual([]);
  expect(await configured("fixture")).toBeUndefined();
});

it.each([{ existing: false }, { existing: true }])(
  "stores manifest timeouts in seconds as config milliseconds (already configured: $existing)",
  async ({ existing }) => {
    if (existing) {
      await mcpConfigInternal.set({ name: "fixture", server: SERVER_WITH_TIMEOUTS });
    }
    const refs: PersistedTemplateMcpServerRef[] = [];
    await installTemplateMcpServersStateless(
      fixturePlan(["fixture"], { ...SERVER, timeout: 30, connectTimeout: 5 }),
      { refs },
    );

    expect(refs).toEqual([
      expect.objectContaining({ relationship: existing ? "referenced" : "managed" }),
    ]);
    expect(await configured("fixture")).toEqual(SERVER_WITH_TIMEOUTS);
  },
);
