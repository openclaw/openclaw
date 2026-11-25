import fs from "node:fs/promises";
import { expect, it } from "vitest";
import { runStartupConfigPreflight } from "../commands/startup-config-preflight.js";
import { resolveExecApprovalsPath } from "../infra/exec-approvals-config.js";
import { resetExecApprovalsMigrationGateForTest } from "../infra/exec-approvals-migration-gate.js";
import { writeExecApprovalsConfigRow } from "../infra/exec-approvals-sqlite.js";
import { loadExecApprovalsReadOnlyAsync } from "../infra/exec-approvals-store.js";
import { readStartupMigrationWarning } from "../infra/state-migrations.messages.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createStartupTestState, gatewayStartupOptions } from "./server-startup.test-support.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";

it("starts with canonical approvals and reports a retained conflicting legacy policy", async () => {
  await using state = await createStartupTestState("gateway-conflicting-legacy-approvals");
  const token = "synthetic-legacy-approvals-gateway-token";
  const claim = await acquireGatewayE2ePortBlock();
  await state.writeConfig({
    agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
    gateway: { auth: { mode: "token", token }, port: claim.port, controlUi: { enabled: false } },
    plugins: { enabled: false },
    discovery: { mdns: { mode: "off" } },
  });
  state.applyEnv();
  writeExecApprovalsConfigRow({
    db: openOpenClawStateDatabase({ env: state.env }).db,
    file: { version: 1, defaults: { security: "deny", ask: "off" }, agents: {} },
  });
  await closeOpenClawStateDatabaseAsync();
  const sourcePath = resolveExecApprovalsPath(state.env);
  const legacy = JSON.stringify({
    version: 1,
    defaults: { security: "full", ask: "off" },
    socket: { token: "synthetic-private-legacy-socket-token" },
    agents: { "synthetic-private-agent": { allowlist: ["/synthetic-private-command"] } },
  });
  await fs.writeFile(sourcePath, legacy);
  resetExecApprovalsMigrationGateForTest();
  const server = await startClaimedGateway(claim, async () => {
    const preflight = await runStartupConfigPreflight({ gateway: true, observe: false });
    try {
      const { startGatewayServer } = await import("./server.js");
      return await startGatewayServer(claim.port, {
        ...gatewayStartupOptions(token),
        startupConfigSnapshotRead: preflight,
      });
    } finally {
      await preflight.pluginCache?.[Symbol.asyncDispose]();
    }
  });
  try {
    await server.startupSettled;
    expect((await fetch(`http://127.0.0.1:${claim.port}/readyz`)).status).toBe(200);
    expect((await loadExecApprovalsReadOnlyAsync({ env: state.env })).defaults).toMatchObject({
      security: "deny",
      ask: "off",
    });
    expect(await fs.readFile(sourcePath, "utf8")).toBe(legacy);
    const warning = readStartupMigrationWarning();
    expect(warning).toContain("legacy-exec-approvals-conflict");
    expect(warning).toContain("older node host or external writer");
    expect(warning).toContain("reconcile this file");
    expect(warning).not.toContain("synthetic-private");
    expect(readStartupMigrationWarning(false)).not.toContain(state.stateDir);
  } finally {
    await server.close();
  }
});
