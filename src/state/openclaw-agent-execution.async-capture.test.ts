import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "./openclaw-agent-db-lifecycle.js";
import {
  createAgentCreationWitnessFixture as fixture,
  createAgentCreationWitnessSource as source,
} from "./openclaw-agent-execution.creation-fixture.test-support.js";
import {
  captureOpenClawAgentDatabaseExecution as capture,
  captureOpenClawAgentDatabaseExecutionAsync as captureAsync,
} from "./openclaw-agent-execution.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateReadContext } from "./openclaw-state-worker-context.js";

it("keeps cold async capture and borrower assertions off main-thread filesystem calls", async () => {
  const options = fixture();
  let publicationLookups = 0;
  let sharedPublicationLookups = 0;
  const observe = (target: unknown) => {
    if (new Error().stack?.includes("publishOpenClawStateDatabaseWorkerAdmission")) {
      sharedPublicationLookups++;
    }
    if (
      target === options.path &&
      /captureRegistryMutation|captureValidationTransfer/.test(new Error().stack ?? "")
    ) {
      publicationLookups++;
    }
  };
  const originalStat = fs.statSync;
  const originalRealpath = fs.realpathSync.native;
  const spies = [
    vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      observe(args[0]);
      return Reflect.apply(originalStat, fs, args);
    }),
    vi
      .spyOn(fs.realpathSync, "native")
      .mockImplementation((...args: Parameters<typeof fs.realpathSync.native>) => {
        observe(args[0]);
        return Reflect.apply(originalRealpath, fs.realpathSync, args);
      }),
  ];
  syncBuiltinESMExports();
  const execution = await captureAsync(options);
  try {
    expect(
      spies
        .flatMap((spy) => spy.mock.calls.map(([pathname]) => pathname))
        .filter((pathname) => pathname === options.path),
    ).toEqual([]);
    for (const spy of spies) {
      spy.mockClear();
    }
    execution.assertCurrent();
    execution.assertCurrent();
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
    let callbackLookups = 0;
    let grants = 0;
    const count = () =>
      spies
        .flatMap((spy) => spy.mock.calls.map(([pathname]) => pathname))
        .filter((pathname) => pathname === options.path).length;
    await execution.prepare({
      assertCurrent: () => execution.assertCurrent(),
      createAdmission(binding) {
        return () => ({
          nativeLocations: binding.nativeLocations,
          admission: createSqliteWorkerOperationAdmission((request, grant) => {
            const before = count();
            binding.authorize(request);
            callbackLookups += count() - before;
            grants++;
            expect(grant()).toBe(true);
          }, binding.attachment),
        });
      },
    });
    expect(grants).toBeGreaterThan(0);
    expect(callbackLookups).toBe(0);
    expect(publicationLookups).toBe(0);
    expect(sharedPublicationLookups).toBe(0);
    expect(execution.fileIdentity).toBeDefined();
  } finally {
    spies.forEach((spy) => spy.mockRestore());
    syncBuiltinESMExports();
    await execution.release();
  }
});

it.each(["created", "replaced", "symlink"] as const)(
  "refuses cold async preparation when the captured target is %s before first use",
  async (change) => {
    const options = fixture();
    const other = path.join(options.env.OPENCLAW_STATE_DIR, "successor.sqlite");
    if (change !== "created") {
      const initial = capture(options);
      await initial.prepare(source());
      await initial.release();
      await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
    }
    const execution = await captureAsync(
      options,
      change === "created"
        ? { expectedCreationIdentity: readDatabasePathIdentitySync(options.path) }
        : {},
    );
    try {
      fs.mkdirSync(path.dirname(options.path), { recursive: true });
      if (change === "symlink") {
        fs.renameSync(options.path, other);
        fs.symlinkSync(other, options.path);
      } else {
        if (change === "replaced") {
          fs.renameSync(options.path, other);
        }
        fs.writeFileSync(options.path, "synthetic successor");
      }
      const before = fs.readFileSync(change === "symlink" ? other : options.path);
      await expect(execution.prepare(source())).rejects.toThrow();
      expect(fs.readFileSync(change === "symlink" ? other : options.path)).toEqual(before);
    } finally {
      await execution.release();
    }
  },
);

it("keeps an ordinary missing async reader missing without creating a store", async () => {
  const options = fixture();
  const execution = await captureAsync(options);
  try {
    await expect(execution.runExisting(source(), async () => true)).resolves.toBeUndefined();
    expect(fs.existsSync(options.path)).toBe(false);
  } finally {
    await execution.release();
  }
});

it("refuses canonical retargeting during awaited async preparation", async () => {
  const options = fixture();
  const other = path.join(options.env.OPENCLAW_STATE_DIR, "retained.sqlite");
  const execution = await captureAsync(options);
  let changed = false;
  const request = source((admission) => {
    if (
      !changed &&
      isRecord(admission.facts) &&
      isRecord(admission.facts.identity) &&
      admission.facts.identity.kind === "file"
    ) {
      fs.renameSync(options.path, other);
      fs.symlinkSync(other, options.path);
      changed = true;
    }
  });
  try {
    await expect(execution.prepare(request)).rejects.toThrow();
    expect(changed).toBe(true);
  } finally {
    await execution.release();
  }
});

it.each(["existing", "missing"] as const)(
  "refuses a %s successor installed while async capture awaits its physical identity",
  async (initial) => {
    const options = fixture();
    const original = initial === "existing" ? capture(options) : undefined;
    await original?.prepare(source());
    const alias = path.join(options.env.OPENCLAW_STATE_DIR, "pending-alias.sqlite");
    if (original) {
      fs.symlinkSync(options.path, alias);
      await capture({ ...options, path: alias }).release();
    }
    const entered = createDeferred();
    const release = createDeferred();
    const stat = fsPromises.stat;
    let waiting = false;
    const spy = vi
      .spyOn(fsPromises, "stat")
      .mockImplementation(async (...args: Parameters<typeof fsPromises.stat>) => {
        if (!waiting && args[0] === options.path) {
          waiting = true;
          entered.resolve();
          await release.promise;
        }
        return Reflect.apply(stat, fsPromises, args);
      });
    syncBuiltinESMExports();
    const pending = captureAsync(original ? { ...options, path: alias } : options);
    const refused = expect(pending).rejects.toThrow(/retired during capture/);
    let successor: ReturnType<typeof capture> | undefined;
    try {
      await entered.promise;
      await closeOpenClawAgentDatabaseByPathAsync(options.path, options.agentId);
      successor = capture(options);
      release.resolve();
      await refused;
      successor.assertCurrent();
    } finally {
      release.resolve();
      await pending.catch(() => {});
      spy.mockRestore();
      syncBuiltinESMExports();
      await successor?.release();
      await original?.release();
    }
  },
);

it.each([
  { target: "existing", supplied: "none" },
  { target: "missing", supplied: "none" },
  { target: "existing", supplied: "canonical" },
  { target: "missing", supplied: "canonical" },
  { target: "existing", supplied: "lexical" },
  { target: "missing", supplied: "lexical" },
] as const)(
  "refuses fresh cached-alias capture after $target retargeting (supplied identity: $supplied), retaining the admitted borrower",
  async ({ target, supplied }) => {
    const options = fixture();
    const alias = path.join(options.env.OPENCLAW_STATE_DIR, "borrowed.sqlite");
    const other = path.join(options.env.OPENCLAW_STATE_DIR, "other.sqlite");
    const creator = capture(options);
    await creator.prepare(source());
    fs.symlinkSync(options.path, alias);
    const execution = await captureAsync({ ...options, path: alias });
    const expected = execution.fileIdentity;
    if (!expected) {
      throw new Error("Prepared synthetic file identity unavailable");
    }
    try {
      if (target === "existing") {
        fs.writeFileSync(other, "synthetic successor");
      }
      fs.unlinkSync(alias);
      fs.symlinkSync(other, alias);
      await expect(
        captureAsync(
          { ...options, path: alias },
          supplied === "none"
            ? {}
            : {
                expectedIdentity: {
                  ...expected,
                  nativeLocation: supplied === "lexical" ? alias : expected.nativeLocation,
                },
              },
        ).then(async (unexpected) => {
          await unexpected.release();
          return unexpected;
        }),
      ).rejects.toThrow(/physical file/);
      await expect(
        execution.runExisting(source(), (scope) =>
          scope.execute({
            type: "session.entry.read",
            input: { sessionKeys: ["agent:main:retained-alias"] },
          }),
        ),
      ).resolves.toMatchObject({ entries: [] });
      await expect(execution.prepare(source())).resolves.toBeUndefined();
    } finally {
      await execution.release();
      await creator.release();
    }
  },
);

it("joins concurrent cold captures without mistaking the first owner for retirement", async () => {
  const options = fixture();
  const executions = await Promise.all([captureAsync(options), captureAsync(options)]);
  try {
    await Promise.all(executions.map((execution) => execution.prepare(source())));
    expect(executions[0].fileIdentity).toEqual(executions[1].fileIdentity);
  } finally {
    await Promise.all(executions.map((execution) => execution.release()));
  }
});

it("reuses the canonical owner's admitted identity without another filesystem observation", async () => {
  const options = fixture();
  const original = capture(options);
  await original.prepare(source());
  const spies = [
    vi.spyOn(fsPromises, "stat"),
    vi.spyOn(fsPromises, "realpath"),
    vi.spyOn(fs, "statSync"),
    vi.spyOn(fs.realpathSync, "native"),
  ];
  syncBuiltinESMExports();
  try {
    const borrowed = await captureAsync(options);
    borrowed.assertCurrent();
    let lexicalConstraints = 0;
    const request = source();
    const createAdmission = request.createAdmission.bind(request);
    request.createAdmission = (binding) => {
      lexicalConstraints += binding.attachment.readCustody?.length ?? 0;
      return createAdmission(binding);
    };
    await borrowed.runExisting(request, (scope) =>
      scope.execute({
        type: "session.entry.read",
        input: { sessionKeys: ["agent:main:warm-canonical"] },
      }),
    );
    expect(lexicalConstraints).toBe(0);
    expect(
      spies
        .flatMap((spy) => spy.mock.calls.map(([pathname]) => pathname))
        .filter((pathname) => pathname === options.path),
    ).toEqual([]);
    await borrowed.release();
  } finally {
    spies.forEach((spy) => spy.mockRestore());
    syncBuiltinESMExports();
    await original.release();
  }
});

it("binds observed absence without inheriting a published owner's old creation witness", async () => {
  const options = fixture();
  const creator = await captureAsync(options, {}, "observed-absence");
  expect(creator.capturedIdentity.key.startsWith("path:")).toBe(true);
  expect(Object.isFrozen(creator.capturedIdentity)).toBe(true);
  await creator.prepare(source());
  const existing = await captureAsync(options, {}, "observed-absence");
  try {
    expect(existing.capturedIdentity.key.startsWith("file:")).toBe(true);
    expect(existing.capturedIdentity.birthtime).toBe(existing.fileIdentity?.birthtime);
    await expect(existing.runExisting(source(), async () => true)).resolves.toBe(true);
  } finally {
    await existing.release();
    await creator.release();
  }
});

it("prepares an explicit creation witness for a preexisting file without adding an ordinary-file constraint", async () => {
  const options = fixture();
  fs.mkdirSync(path.dirname(options.path), { recursive: true });
  fs.writeFileSync(options.path, "");
  const captured = readDatabasePathIdentitySync(options.path);
  const execution = await captureAsync(options, { expectedCreationIdentity: captured });
  try {
    await execution.prepare(source());
    expect(execution.fileIdentity?.physicalIdentity).toBe(captured.key.slice("file:".length));
    expect(execution.capturedIdentity).toEqual(captured);
  } finally {
    await execution.release();
  }
});

it("refuses shared-state replacement at its cold native publication boundary", async () => {
  const options = fixture();
  const shared = openOpenClawStateDatabase({ env: options.env });
  shared.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const replacement = fs.readFileSync(shared.path);
  const retained = `${shared.path}.retained`;
  const originalAdmission = captureOpenClawStateReadContext(shared.path).admission;
  const originalIdentity = originalAdmission.identity.key;
  const execution = await captureAsync(options);
  let replaced = false;
  let reconciliationLookups = 0;
  const observeReconciliation = () => {
    if (new Error().stack?.includes("retireChangedAdmission")) {
      reconciliationLookups++;
    }
  };
  const originalStat = fs.statSync;
  const originalRealpath = fs.realpathSync.native;
  const spies = [
    vi.spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
      observeReconciliation();
      return Reflect.apply(originalStat, fs, args);
    }),
    vi
      .spyOn(fs.realpathSync, "native")
      .mockImplementation((...args: Parameters<typeof fs.realpathSync.native>) => {
        observeReconciliation();
        return Reflect.apply(originalRealpath, fs.realpathSync, args);
      }),
  ];
  syncBuiltinESMExports();
  try {
    await expect(
      execution.prepare(
        source((request) => {
          if (
            !replaced &&
            request.stage === "prepare" &&
            isRecord(request.facts) &&
            request.facts.kind === "shared-owner"
          ) {
            fs.renameSync(shared.path, retained);
            fs.writeFileSync(shared.path, replacement);
            replaced = true;
          }
        }),
      ),
    ).rejects.toThrow("SQLite database file identity changed before existing-only open");
    expect(replaced).toBe(true);
    expect(reconciliationLookups).toBe(0);
    expect(fs.readFileSync(shared.path)).toEqual(replacement);
    expect(fs.existsSync(options.path)).toBe(false);
    expect(originalAdmission.assertCurrent).toThrow(/admission changed/);
    const freshAdmission = captureOpenClawStateReadContext(shared.path).admission;
    expect(freshAdmission.identity.key).not.toBe(originalIdentity);
    expect(freshAdmission.identity).toEqual(readDatabasePathIdentitySync(shared.path));
    freshAdmission.assertCurrent();
  } finally {
    try {
      await execution.release();
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      syncBuiltinESMExports();
      if (replaced) {
        fs.unlinkSync(shared.path);
        fs.renameSync(retained, shared.path);
      }
    }
  }
});
