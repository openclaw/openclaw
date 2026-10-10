import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveDatabasePath } from "../state/openclaw-state-db.paths.js";
import { invokeRegisteredNodeHostCommand } from "./plugin-node-host.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "node-plugin-exec-policy-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  setRuntimeConfigSnapshot({});
  saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" } });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function launch(
  source: "session-full" | "human-approved",
  whilePreparing: () => void = () => {},
  observeGuard?: () => () => void,
  legacy = false,
) {
  const spawn = vi.fn();
  const controller = new AbortController();
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(
    createPluginRecord({
      id: "fixture",
      source: "fixture",
      origin: "bundled",
      enabled: true,
      configSchema: true,
    }),
  );
  registry.nodeHostCommands.push({
    pluginId: "fixture",
    pluginName: "Fixture",
    source: "fixture",
    command: {
      command: "fixture.exec",
      dangerous: true,
      handle: async (_params, _io, context) => {
        const assertAuthorized = legacy
          ? context!.prepareExecAuthorization!(source)
          : await context!.prepareExecAuthorizationAsync!(source);
        await Promise.resolve();
        whilePreparing();
        const stopObserving = observeGuard?.();
        try {
          assertAuthorized();
        } finally {
          stopObserving?.();
        }
        spawn();
        return "{}";
      },
    },
  });
  setActivePluginRegistry(registry);
  const result = invokeRegisteredNodeHostCommand("fixture.exec", "{}", undefined, {
    sendNodeEvent: async () => undefined,
    sessionKey: "agent:main:session",
    signal: controller.signal,
  });
  return { result, spawn, controller, registry };
}

function setPolicy(
  owner: "config" | "approvals" | "foreign-approvals",
  security: ExecSecurity,
  ask: ExecAsk,
) {
  if (owner === "config") {
    setRuntimeConfigSnapshot({ tools: { exec: { security, ask } } });
  } else if (owner === "foreign-approvals") {
    const db = new DatabaseSync(resolveDatabasePath());
    try {
      db.prepare("UPDATE exec_approvals_config SET raw_json = ? WHERE config_key = 'current'").run(
        JSON.stringify({ version: 1, defaults: { security, ask } }),
      );
    } finally {
      db.close();
    }
  } else {
    saveExecApprovals({ version: 1, defaults: { security, ask } });
  }
}

describe("plugin node execution authorization", () => {
  it("initializes missing state before the first authorized invocation", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "first-use"));
    setRuntimeConfigSnapshot({ tools: { exec: { security: "full", ask: "off" } } });
    const databasePath = resolveDatabasePath();
    expect(fs.existsSync(databasePath)).toBe(false);

    const { result, spawn } = launch("session-full");
    await expect(result).resolves.toBe("{}");
    expect(spawn).toHaveBeenCalledOnce();
    expect(fs.existsSync(databasePath)).toBe(true);
  });

  it("prepares policy off-thread and performs no host SQL after cold reader admission", async () => {
    for (const phase of ["cold", "warm"] as const) {
      const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        const { result, spawn } = launch("session-full", () => {
          observation.restore();
          if (phase === "cold") {
            // prepareOpenClawStateDirectReader retains one-time native schema admission;
            // approval policy preparation itself belongs to the worker from the first call.
            expect(observation.queries).not.toContainEqual(
              expect.stringMatching(/\bexec_approvals_config\b/),
            );
          } else {
            expect(observation.queries).toEqual([]);
          }
        });
        await expect(result).resolves.toBe("{}");
        expect(spawn).toHaveBeenCalledOnce();
      } finally {
        observation.restore();
      }
    }
  });

  it("retains the released synchronous guard and observes policy revocation before spawn", async () => {
    const { result, spawn } = launch(
      "session-full",
      () => setPolicy("approvals", "deny", "off"),
      undefined,
      true,
    );
    await expect(result).rejects.toThrow("Exec approval changed before execution");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("checks a foreign policy change with one indexed read immediately before spawn", async () => {
    let queries: string[] = [];
    const { result, spawn } = launch(
      "session-full",
      () => setPolicy("foreign-approvals", "deny", "off"),
      () => {
        const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
        queries = observation.queries;
        return observation.restore;
      },
    );
    await expect(result).rejects.toThrow("Exec approval changed before execution");
    expect(spawn).not.toHaveBeenCalled();
    expect(queries).toEqual([
      'select "raw_json" from "exec_approvals_config" where "config_key" = ?',
    ]);
  });

  it.each(["config", "approvals"] as const)(
    "keeps %s restrictions for Full and explicit human decisions",
    async (owner) => {
      for (const security of ["full", "allowlist", "deny"] as const) {
        for (const ask of ["off", "on-miss", "always"] as const) {
          for (const source of ["session-full", "human-approved"] as const) {
            setPolicy(owner, security, ask);
            const { result, spawn } = launch(source);
            const allowed =
              source === "human-approved"
                ? security !== "deny"
                : security === "full" && ask === "off";
            if (allowed) {
              await expect(result).resolves.toBe("{}");
              expect(spawn).toHaveBeenCalledOnce();
            } else {
              await expect(result).rejects.toThrow(
                owner === "config"
                  ? "node-local exec policy does not authorize this launch"
                  : "Exec approval changed before execution",
              );
              expect(spawn).not.toHaveBeenCalled();
            }
          }
        }
      }
    },
  );

  it.each(["config", "approvals", "foreign-approvals"] as const)(
    "refuses %s tightening during awaited setup",
    async (owner) => {
      for (const source of ["session-full", "human-approved"] as const) {
        for (const [security, ask] of [
          ["deny", "off"],
          ["allowlist", "off"],
          ["full", "always"],
        ] as const) {
          setPolicy(owner, "full", "off");
          const tightenPolicy = vi.fn(() => setPolicy(owner, security, ask));
          const { result, spawn } = launch(source, tightenPolicy);
          await expect(result).rejects.toThrow(
            owner === "config"
              ? "node-local exec policy does not authorize this launch"
              : "Exec approval changed before execution",
          );
          expect(tightenPolicy).toHaveBeenCalledOnce();
          expect(spawn).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each(["cancel", "plugin-replaced"] as const)(
    "refuses %s during awaited setup",
    async (reason) => {
      const invocation = launch("session-full", () => {
        if (reason === "cancel") {
          invocation.controller.abort();
        } else {
          setActivePluginRegistry(createEmptyPluginRegistry());
        }
      });
      await expect(invocation.result).rejects.toThrow("authority is closed");
      expect(invocation.spawn).not.toHaveBeenCalled();
    },
  );
});
