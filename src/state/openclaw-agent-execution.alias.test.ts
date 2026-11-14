import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { defaultPayload } from "../infra/gateway-state-owner-record.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesAsync,
} from "./openclaw-agent-db-lifecycle.js";
import {
  createAliasedAgentCreationWitnessFixture as fixture,
  createAgentCreationWitnessSource as source,
} from "./openclaw-agent-execution.creation-fixture.test-support.js";
import { captureOpenClawAgentDatabaseExecution as capture } from "./openclaw-agent-execution.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

it.each(["removed", "replaced"])("closes after %s state lock", async (ending) => {
  const { options, aliased } = fixture();
  const databasePath = resolveOpenClawStateSqlitePath(options.env);
  const payload = { ...defaultPayload(databasePath), role: "gateway" as const };
  const owner = acquireGatewayStateOwner({ databasePath, payload });
  const creator = capture(aliased, {
    expectedCreationIdentity: readDatabasePathIdentitySync(aliased.path),
  });
  const canonical = capture(options);
  const successor = capture({
    ...options,
    path: path.join(options.env.OPENCLAW_STATE_DIR, "successor", "agent.sqlite"),
  });
  const alias = path.dirname(aliased.path);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  const sessionKey = "agent:main:retarget-proof";
  const read = async (execution: typeof creator) => {
    const result = await execution.runExisting(source(), (scope) =>
      scope.execute({ type: "session.entry.read", input: { sessionKeys: [sessionKey] } }),
    );
    return result?.entries.map((row) => [row.sessionKey, row.entry.sessionId]);
  };
  const write = (execution: typeof creator, sessionId: string) =>
    execution.runExisting(source(), (scope) =>
      scope.execute({
        type: "session.entries.replace",
        input: {
          expectedRows: new Map(),
          labelOwnerKeys: [],
          validationKeys: [sessionKey],
          replacements: [{ sessionKey, entry: { sessionId, updatedAt: 1 } }],
        },
      }),
    );
  try {
    await successor.prepare(source());
    await write(successor, "successor-session");
    await creator.prepare(source());
    const receipt = creator.fileIdentity;
    expect(receipt).toBeDefined();
    expect(receipt?.physicalIdentity).not.toBe(successor.fileIdentity?.physicalIdentity);
    fs.unlinkSync(alias);
    fs.symlinkSync(path.dirname(successor.path), alias, linkType);
    await write(creator, "original-session");
    for (const execution of [creator, canonical]) {
      await expect(read(execution)).resolves.toEqual([[sessionKey, "original-session"]]);
      expect(execution.fileIdentity).toEqual(receipt);
    }
    await closeOpenClawAgentDatabaseByPathAsync(aliased.path, options.agentId);
    expect(() => creator.assertCurrent()).toThrow(/closed/);
    expect(() => canonical.assertCurrent()).toThrow(/closed/);
    await expect(read(successor)).resolves.toEqual([[sessionKey, "successor-session"]]);
    fs.unlinkSync(owner.path);
    const replacement = JSON.stringify({
      ...payload,
      pid: process.ppid,
      startTime: undefined,
      role: "sqlite-maintenance",
      ownerId: "replacement-live-owner",
    });
    if (ending === "replaced") {
      fs.writeFileSync(owner.path, replacement);
    }
    await expect(closeOpenClawAgentDatabasesAsync()).resolves.toBeUndefined();
    expect(fs.existsSync(owner.path)).toBe(ending === "replaced");
    if (ending === "replaced") {
      expect(fs.readFileSync(owner.path, "utf8")).toBe(replacement);
    }
    expect(() => successor.assertCurrent()).toThrow(/closed/);
  } finally {
    owner.release();
    fs.rmSync(owner.path, { force: true }); // Only this test's synthetic successor lock.
    await Promise.allSettled([creator.release(), canonical.release(), successor.release()]);
  }
});
