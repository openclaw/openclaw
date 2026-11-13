import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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

it("prepares native Gateway ownership without synchronous filesystem lookup", async () => {
  const { options } = fixture();
  const databasePath = resolveOpenClawStateSqlitePath(options.env);
  const owner = acquireGatewayStateOwner({
    databasePath,
    payload: { ...defaultPayload(databasePath), role: "gateway" },
  });
  const execution = capture(options);
  const realpath = fs.realpathSync.native;
  let generationLookups = 0;
  const observed = vi
    .spyOn(fs.realpathSync, "native")
    .mockImplementation((...args: Parameters<typeof fs.realpathSync.native>) => {
      if (new Error().stack?.includes("createAgentDatabaseNativeGeneration")) {
        generationLookups++;
      }
      return Reflect.apply(realpath, fs.realpathSync, args);
    });
  syncBuiltinESMExports();
  try {
    await execution.prepare(source());
    expect(execution.fileIdentity).toBeDefined();
    expect(generationLookups).toBe(0);
  } finally {
    observed.mockRestore();
    syncBuiltinESMExports();
    await execution.release();
    owner.release();
  }
});

it("rechecks the request after awaited native Gateway ownership preparation", async () => {
  const { options } = fixture();
  const databasePath = resolveOpenClawStateSqlitePath(options.env);
  const owner = acquireGatewayStateOwner({
    databasePath,
    payload: { ...defaultPayload(databasePath), role: "gateway" },
  });
  const execution = capture(options);
  const entered = createDeferred();
  const resume = createDeferred();
  const realpath = fsPromises.realpath;
  let held = false;
  let revoked = false;
  const observed = vi
    .spyOn(fsPromises, "realpath")
    .mockImplementation(async (...args: Parameters<typeof fsPromises.realpath>) => {
      if (!held && args[0] === databasePath) {
        held = true;
        entered.resolve();
        await resume.promise;
      }
      return Reflect.apply(realpath, fsPromises, args);
    });
  syncBuiltinESMExports();
  const request = source();
  request.assertCurrent = () => {
    if (revoked) {
      throw new Error("Synthetic request retired during native preparation");
    }
  };
  const pending = execution.prepare(request);
  try {
    await entered.promise;
    revoked = true;
    resume.resolve();
    await expect(pending).rejects.toThrow("Synthetic request retired during native preparation");
    expect(fs.existsSync(options.path)).toBe(false);
  } finally {
    resume.resolve();
    await pending.catch(() => {});
    observed.mockRestore();
    syncBuiltinESMExports();
    await execution.release();
    owner.release();
  }
});

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
    path: path.join(options.env.OPENCLAW_STATE_DIR, "successor", path.basename(options.path)),
  });
  const alias = path.dirname(aliased.path);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  let fresh: ReturnType<typeof capture> | undefined;
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
    expect(() => {
      fresh = capture(aliased);
    }).toThrow(/identity changed/);
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
    await Promise.allSettled([
      creator.release(),
      canonical.release(),
      successor.release(),
      fresh?.release(),
    ]);
  }
});
