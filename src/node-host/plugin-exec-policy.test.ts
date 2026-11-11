import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as config from "../config/runtime-snapshot.js";
import { saveExecApprovals } from "../infra/exec-approvals-store.test-support.js";
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import * as state from "../state/openclaw-state-db.js";
import { invokeRegisteredNodeHostCommand } from "./plugin-node-host.js";

beforeEach(() => {
  const root = tempDirs.make("node-plugin-exec-policy-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  config.setRuntimeConfigSnapshot({});
  saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" } });
});
afterEach(async () => {
  await state.closeOpenClawStateDatabaseAsync();
  state.closeOpenClawStateDatabaseForTest();
  config.clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function checkLaunch(
  source: "session-full" | "human-approved",
  options: {
    prepare?: (controller: AbortController) => void;
    allowed?: boolean;
    rejection?: string;
    observe?: () => () => void;
  } = {},
) {
  const spawn = vi.fn();
  const controller = new AbortController();
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "fixture" }));
  registry.nodeHostCommands.push({
    pluginId: "fixture",
    source: "fixture",
    command: {
      command: "fixture.exec",
      dangerous: true,
      handle: async (_params, _io, context) => {
        const assertAuthorized = context!.prepareExecAuthorization!(source);
        await Promise.resolve();
        options.prepare?.(controller);
        const stopObserving = options.observe?.();
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
  if (options.allowed) {
    await expect(result).resolves.toBe("{}");
  } else {
    await expect(result).rejects.toThrow(options.rejection);
  }
  expect(spawn).toHaveBeenCalledTimes(options.allowed ? 1 : 0);
}

function setPolicy(owner: "config" | "approvals", security: ExecSecurity, ask: ExecAsk) {
  if (owner === "config") {
    config.setRuntimeConfigSnapshot({ tools: { exec: { security, ask } } });
  } else {
    saveExecApprovals({ version: 1, defaults: { security, ask } });
  }
}

it("checks an in-process policy change without SQLite immediately before spawn", async () => {
  let queries: string[] = [];
  await checkLaunch("session-full", {
    prepare: () => setPolicy("approvals", "deny", "off"),
    observe: () => {
      const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      queries = observation.queries;
      return observation.restore;
    },
  });
  expect(queries).toEqual([]);
});

it.each([
  ["config", "initial"],
  ["config", "tightened"],
  ["approvals", "initial"],
  ["approvals", "tightened"],
] as const)("%s policy is enforced when %s", async (owner, timing) => {
  const tightened = timing === "tightened";
  for (const security of ["full", "allowlist", "deny"] as const) {
    const asks: ExecAsk[] = tightened
      ? [security === "full" ? "always" : "off"]
      : ["off", "on-miss", "always"];
    for (const ask of asks) {
      for (const source of ["session-full", "human-approved"] as const) {
        setPolicy(owner, tightened ? "full" : security, tightened ? "off" : ask);
        const allowed =
          !tightened &&
          (source === "human-approved"
            ? security !== "deny"
            : security === "full" && ask === "off");
        await checkLaunch(source, {
          allowed,
          prepare: tightened ? () => setPolicy(owner, security, ask) : undefined,
        });
      }
    }
  }
});

it.each(["cancel", "plugin-replaced"] as const)(
  "refuses %s during awaited setup",
  async (reason) => {
    await checkLaunch("session-full", {
      prepare: (controller) => {
        if (reason === "cancel") {
          controller.abort();
        } else {
          setActivePluginRegistry(createEmptyPluginRegistry());
        }
      },
      rejection: "authority is closed",
    });
  },
);
