import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolvePackageActivationAnchor,
  PACKAGE_ACTIVATION_JOURNAL,
} from "../../infra/package-update-activation-journal.js";
import { PACKAGE_ACTIVATION_HELPER } from "../../infra/package-update-activation-runtime-assets.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { updateExecutorEntrypoints } from "../cli-entrypoint.test-support.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  captureUpdateCommandExecutorAuthority,
  requiresRetainedUpdateCommandOwner,
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let serviceRoot: string;
let candidateRoot: string;
beforeEach(() => {
  const base = fs.realpathSync(dirs.make("retained-update-owner-"));
  root = path.join(base, "package-B");
  serviceRoot = path.join(base, "service-A");
  candidateRoot = path.join(base, "candidate-C");
  const control = path.join(base, "control");
  for (const directory of [root, serviceRoot, candidateRoot, control]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
});
afterEach(() => vi.restoreAllMocks());

const ownerModule = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.executor).href;
const commandModule = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.processExec).href;
const activationModule = resolveRuntimeWorkerUrl(updateExecutorEntrypoints.activation).href;
const program = `
  import fs from "node:fs";
  import assert from "node:assert/strict";
  import {setTimeout} from "node:timers/promises";
  import {withDelegatedUpdateCommandExecutor,withUpdateCommandExecutorChild,captureUpdateCommandExecutorAuthority,requiresRetainedUpdateCommandOwner,releaseUpdateCommandPreflightForHandoff} from ${JSON.stringify(ownerModule)};
  import {runUtf8CommandWithTimeout} from ${JSON.stringify(commandModule)};
  import {assertNoPendingPackageActivation} from ${JSON.stringify(activationModule)};
  const input=JSON.parse(fs.readFileSync(0,"utf8"));
  await withDelegatedUpdateCommandExecutor(input.grant,input.grant.runId,input.grant.root,async(fence)=>{
    assert.deepEqual(captureUpdateCommandExecutorAuthority(fence),input.authority);
    assert.equal(requiresRetainedUpdateCommandOwner(fence),true);
    assert.throws(()=>releaseUpdateCommandPreflightForHandoff(fence),/not current/);
    assertNoPendingPackageActivation(input.authority.installKey,{continuation:fence});
    if(input.nextRoot) {
      const result=await withUpdateCommandExecutorChild(fence,input.nextRoot,(grant,beforeInput)=>
        runUtf8CommandWithTimeout([process.execPath,"--input-type=module","-e",input.program],{
          input:JSON.stringify({...input,grant,nextRoot:undefined}),beforeInput,timeoutMs:20000,
          killProcessTree:true,requireProcessTreeExtinction:true,onOutputChunk:chunk=>process.stdout.write(chunk)
        }),{auxiliaryPreflight:true});
      assert.throws(()=>releaseUpdateCommandPreflightForHandoff(fence),/not current/);
      if(result.code!==0)throw new Error(result.stderr);
      fence.assertCurrent();
    } else {
      fs.writeFileSync(input.receipt,JSON.stringify({retainedChild:input.grant.retainedChildKey,authority:captureUpdateCommandExecutorAuthority(fence)}));
      process.stdout.write("admitted-leaf\\n");
      while(!fs.existsSync(input.proceed))await setTimeout(10);
      fence.assertCurrent();
      assertNoPendingPackageActivation(input.authority.installKey,{continuation:fence});
      fs.writeFileSync(input.output,"owned");
    }
  });
`;

it.each([
  { destination: "C", revoke: "none" },
  { destination: "C", revoke: "B" },
  { destination: "C", revoke: "A" },
  { destination: "C", revoke: "A-child" },
  { destination: "C", revoke: "C" },
  { destination: "A", revoke: "none" },
  { destination: "B", revoke: "none" },
] as const)(
  "retains B capture and live A through nested B->$destination, revoke $revoke",
  async ({ destination, revoke }) => {
    const leafRoot = destination === "C" ? candidateRoot : destination === "A" ? serviceRoot : root;
    const receipt = path.join(root, "receipt");
    const proceed = path.join(root, "proceed");
    const output = path.join(root, "effect");
    const ready = createDeferred();
    let revokedKey: string | undefined;
    const work = withUpdateCommandExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root, { serviceRoot });
      expect(requiresRetainedUpdateCommandOwner(fence)).toBe(true);
      const authority = captureUpdateCommandExecutorAuthority(fence);
      publishedPackageFixture(authority);
      const pending = withUpdateCommandExecutorChild(fence, root, (grant, beforeInput) =>
        runUtf8CommandWithTimeout([process.execPath, "--input-type=module", "-e", program], {
          input: JSON.stringify({
            grant,
            authority,
            nextRoot: leafRoot,
            receipt,
            proceed,
            output,
            program,
          }),
          beforeInput,
          timeoutMs: 30000,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
          onOutputChunk: (chunk) => {
            if (chunk.toString().includes("admitted-leaf")) {
              ready.resolve();
            }
          },
        }),
      );
      try {
        await Promise.race([
          ready.promise,
          pending.then((result) => {
            throw new Error(result.stderr);
          }),
        ]);
        const observed: { retainedChild: string; authority: unknown } = JSON.parse(
          fs.readFileSync(receipt, "utf8"),
        );
        expect(observed.authority).toEqual(authority);
        const store = createManagedHandoffLeaseStore();
        for (const key of [root, serviceRoot, leafRoot]) {
          const current = store.read(key);
          assert(current.kind === "current");
          expect(store.release(current.lease)).toBe(false);
          expect(store.acquire(key, "contender", { kind: "update" }).kind).toBe("busy");
        }
        if (revoke !== "none") {
          revokedKey =
            revoke === "B"
              ? root
              : revoke === "A"
                ? serviceRoot
                : revoke === "C"
                  ? candidateRoot
                  : observed.retainedChild;
          const db = new DatabaseSync(authority.databasePath);
          try {
            db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
              "replacement",
              revokedKey,
            );
          } finally {
            db.close();
          }
        }
      } finally {
        fs.writeFileSync(proceed, "continue");
      }
      const result = await pending;
      expect(result.code, result.stderr).toBe(0);
      fence.assertCurrent();
    });
    if (revoke === "none") {
      await work;
      expect(fs.readFileSync(output, "utf8")).toBe("owned");
      for (const key of [root, serviceRoot, candidateRoot]) {
        expect(createManagedHandoffLeaseStore().read(key)).toEqual({ kind: "absent" });
      }
    } else {
      await expect(work).rejects.toThrow();
      expect(fs.existsSync(output)).toBe(false);
      expect(createManagedHandoffLeaseStore().read(revokedKey!)).toMatchObject({
        kind: "current",
        lease: { owner: "replacement" },
      });
    }
  },
);

it.each([
  "parent-only",
  "key-only",
  "both",
  "legacy-digest",
  "null-parent",
  "wrong-key",
  "wrong-generation",
  "wrong-start",
] as const)("refuses retained grant tampering before receiver effects: %s", async (tamper) => {
  const output = path.join(root, "effect");
  const proceed = path.join(root, "proceed");
  fs.writeFileSync(proceed, "continue");
  await withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const fence = await executor.enter(root, { serviceRoot });
    const authority = captureUpdateCommandExecutorAuthority(fence);
    const result = await withUpdateCommandExecutorChild(
      fence,
      candidateRoot,
      (grant, beforeInput) => {
        const changed: Record<string, unknown> = { ...grant };
        if (tamper === "parent-only" || tamper === "both" || tamper === "legacy-digest") {
          delete changed.retainedParent;
        }
        if (tamper === "key-only" || tamper === "both" || tamper === "legacy-digest") {
          delete changed.retainedChildKey;
        }
        if (tamper === "null-parent") {
          changed.retainedParent = null;
        }
        if (tamper === "wrong-key") {
          changed.retainedChildKey = grant.originalChildKey;
        }
        if (tamper === "wrong-generation") {
          changed.retainedParent = {
            ...grant.retainedParent,
            updatedAt: grant.retainedParent!.updatedAt + 1,
          };
        }
        if (tamper === "wrong-start") {
          changed.retainedParent = {
            ...grant.retainedParent,
            executor: { ...grant.retainedParent!.executor, startIdentity: "wrong-start" },
          };
        }
        if (tamper === "legacy-digest") {
          const database = grant.databaseIdentity!;
          const digest = createHash("sha256")
            .update(
              JSON.stringify([
                database.databasePath,
                database.databaseIdentity,
                database.parentIdentity,
                [grant.originalParent!, grant.spawner!, grant.parent].map((lease) => [
                  lease.key,
                  lease.owner,
                  lease.payload,
                  lease.updatedAt,
                ]),
              ]),
            )
            .digest("hex");
          changed.childKey = grant.childKey.replace(/lineage-[a-f0-9]{64}$/, `lineage-${digest}`);
          changed.originalChildKey = grant.originalChildKey!.replace(
            /lineage-[a-f0-9]{64}$/,
            `lineage-${digest}`,
          );
        }
        return runUtf8CommandWithTimeout([process.execPath, "--input-type=module", "-e", program], {
          input: JSON.stringify({
            grant: changed,
            authority,
            proceed,
            output,
            receipt: path.join(root, "receipt"),
          }),
          beforeInput,
          timeoutMs: 15000,
          killProcessTree: true,
          requireProcessTreeExtinction: true,
        });
      },
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/retained owner pair|does not match its parent/);
    expect(fs.existsSync(output)).toBe(false);
    fence.assertCurrent();
  });
});

// Exercise the actual package continuation consumer against a valid private
// journal whose authority comes from this live admission, not a guessed owner.
function publishedPackageFixture(
  authority: ReturnType<typeof captureUpdateCommandExecutorAuthority>,
) {
  const anchor = resolvePackageActivationAnchor(authority.installKey);
  fs.mkdirSync(anchor, { mode: 0o700 });
  const journal = path.join(anchor, PACKAGE_ACTIVATION_JOURNAL);
  const helper = path.join(anchor, PACKAGE_ACTIVATION_HELPER);
  const helperSource = "// Inert published-journal fixture, never executed.\n";
  fs.writeFileSync(helper, helperSource, { mode: 0o600 });
  const db = new DatabaseSync(journal);
  fs.chmodSync(journal, 0o600);
  const identity = (file: string) => {
    const stat = fs.lstatSync(file, { bigint: true });
    return `${stat.dev}:${stat.ino}`;
  };
  const fingerprint = {
    digest: createHash("sha256").update("fixture-package").digest("hex"),
    identity: identity(root),
    version: "2026.9.4",
  };
  try {
    db.exec(
      "PRAGMA journal_mode=DELETE; CREATE TABLE package_activation (slot INTEGER PRIMARY KEY, revision INTEGER, phase TEXT, descriptor_json TEXT, intent_json TEXT, publications_json TEXT)",
    );
    db.prepare(
      "INSERT INTO package_activation VALUES (1,0,'publication-complete',?,'null','[]')",
    ).run(
      JSON.stringify({
        version: 1,
        operationId: randomUUID(),
        authority,
        anchorIdentity: identity(anchor),
        journalIdentity: identity(journal),
        parentIdentity: identity(path.dirname(anchor)),
        binDir: root,
        binIdentity: identity(root),
        originalStageRoot: candidateRoot,
        previous: fingerprint,
        candidate: { ...fingerprint, identity: identity(candidateRoot) },
        launcherRootIdentity: identity(root),
        previousLauncherRootIdentity: null,
        helperDigest: createHash("sha256").update(helperSource).digest("hex"),
        launchers: [],
      }),
    );
  } finally {
    db.close();
  }
}
