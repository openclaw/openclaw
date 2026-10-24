import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assert, beforeEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
  resolvePackageActivationHelper,
  type PackageActivationDescriptor,
} from "../../infra/package-update-activation-journal.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import { runUtf8CommandWithTimeout, type CommandOptions } from "../../process/exec.js";
import { updateExecutorEntrypoints } from "../cli-entrypoint.test-support.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  captureUpdateCommandExecutorAuthority as authorityOf,
  requiresRetainedUpdateCommandOwner as requiresRetainedOwner,
  withUpdateCommandExecutor as withExecutor,
  withUpdateCommandExecutorChild as withChild,
} from "./update-command-executor.js";
import { useExecutorFixture } from "./update-command-executor.test-support.js";

const fixture = useExecutorFixture("retained-update-owner-", { splitRoots: true });
let root: string;
let serviceRoot: string;
let candidateRoot: string;
let receipt: string;
let proceed: string;
let output: string;
beforeEach(() => {
  ({ root, serviceRoot } = fixture());
  candidateRoot = path.join(path.dirname(root), "candidate-C");
  receipt = path.join(root, "receipt");
  proceed = path.join(root, "proceed");
  output = path.join(root, "effect");
  fs.mkdirSync(candidateRoot, { mode: 0o700 });
});

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
  const {json}=await import("node:stream/consumers");
  const input=await json(process.stdin);
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

function receiver(input: Record<string, unknown>, options: CommandOptions) {
  return runUtf8CommandWithTimeout([process.execPath, "--input-type=module", "-e", program], {
    input: JSON.stringify({ receipt, proceed, output, ...input }),
    killProcessTree: true,
    requireProcessTreeExtinction: true,
    ...options,
  });
}

it.each([
  { destination: "direct-C", revoke: "none" },
  { destination: "direct-C", revoke: "B" },
  { destination: "direct-C", revoke: "A" },
  { destination: "direct-C", revoke: "C" },
  { destination: "C", revoke: "none" },
  { destination: "C", revoke: "B" },
  { destination: "C", revoke: "A" },
  { destination: "C", revoke: "A-child" },
  { destination: "C", revoke: "C" },
  { destination: "B", revoke: "none" },
  { destination: "A", revoke: "none" },
] as const)(
  "checks retained A authority through B->$destination, revoke $revoke",
  async ({ destination, revoke }) => {
    const direct = destination === "direct-C";
    const leafRoot =
      direct || destination === "C" ? candidateRoot : destination === "A" ? serviceRoot : root;
    const ready = createDeferred();
    let revokedKey: string | undefined;
    const work = withExecutor(randomUUID(), async (executor) => {
      const fence = await executor.enter(root, { serviceRoot });
      expect(requiresRetainedOwner(fence)).toBe(true);
      const authority = authorityOf(fence);
      publishedPackageFixture(authority);
      const pending = withChild(fence, direct ? leafRoot : root, (grant, beforeInput) =>
        receiver(
          { grant, authority, nextRoot: direct ? undefined : leafRoot, program },
          {
            beforeInput,
            timeoutMs: 30000,
            onOutputChunk: (chunk) => {
              if (chunk.toString().includes("admitted-leaf")) {
                ready.resolve();
              }
            },
          },
        ),
      );
      if (destination === "A") {
        const result = await pending;
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("Retained service root is not a candidate executor");
        expect(fs.existsSync(receipt)).toBe(false);
        expect(fs.existsSync(output)).toBe(false);
        fence.assertCurrent();
        return;
      }
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
        expect(() => fence.assertCurrent()).toThrow("The update process is still running.");
        const store = createManagedHandoffLeaseStore();
        for (const key of [root, serviceRoot, leafRoot]) {
          const current = store.read(key);
          assert(current.kind === "current");
          expect(store.release(current.lease)).toBe(false);
          if (key === root) {
            expect(store.bind(current.lease, process.pid)).toBeNull();
          }
          expect(store.acquire(key, "contender", { kind: "update" }).kind).toBe("busy");
        }
        if (revoke !== "none") {
          revokedKey = {
            B: root,
            A: serviceRoot,
            C: candidateRoot,
            "A-child": observed.retainedChild,
          }[revoke];
          using db = new DatabaseSync(authority.databasePath);
          db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
            "replacement",
            revokedKey,
          );
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
      if (destination !== "A") {
        expect(fs.readFileSync(output, "utf8")).toBe("owned");
      }
      for (const key of [root, serviceRoot, candidateRoot]) {
        expect(createManagedHandoffLeaseStore().read(key)).toEqual({ kind: "absent" });
      }
    } else {
      await expect(work).rejects.toThrow(
        destination === "direct-C" ? /ownership|release/ : undefined,
      );
      expect(fs.existsSync(output)).toBe(false);
      expect(createManagedHandoffLeaseStore().read(revokedKey!)).toMatchObject({
        kind: "current",
        lease: { owner: "replacement" },
      });
      if (revoke === "C") {
        expect(
          createManagedHandoffLeaseStore().acquire(root, "next-original", { kind: "update" }).kind,
        ).toBe("busy");
      }
      if (revoke === "B") {
        expect(createManagedHandoffLeaseStore().read(candidateRoot)).toEqual({ kind: "absent" });
      }
    }
  },
);

it.each([
  "parent-only",
  "key-only",
  "both",
  "legacy-digest",
  "wrong-key",
  "wrong-generation",
  "wrong-start",
] as const)("refuses retained grant tampering before receiver effects: %s", async (tamper) => {
  fs.writeFileSync(proceed, "continue");
  await withExecutor(randomUUID(), async (executor) => {
    const fence = await executor.enter(root, { serviceRoot });
    const authority = authorityOf(fence);
    const result = await withChild(fence, candidateRoot, (grant, beforeInput) => {
      const changed: Record<string, unknown> = { ...grant };
      if (tamper === "parent-only" || tamper === "both" || tamper === "legacy-digest") {
        delete changed.retainedParent;
      }
      if (tamper === "key-only" || tamper === "both" || tamper === "legacy-digest") {
        delete changed.retainedChildKey;
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
      return receiver({ grant: changed, authority }, { beforeInput, timeoutMs: 15000 });
    });
    expect(result.code).not.toBe(0);
    if (["both", "wrong-key", "wrong-generation"].includes(tamper)) {
      expect(result.stderr).toContain("Candidate executor lineage is missing or invalid.");
    } else {
      expect(result.stderr).toMatch(/retained owner pair|does not match its parent/);
    }
    expect(fs.existsSync(receipt)).toBe(false);
    expect(fs.existsSync(output)).toBe(false);
    fence.assertCurrent();
  });
});

// Exercise the actual package continuation consumer against a valid private
// journal whose authority comes from this live admission, not a guessed owner.
function publishedPackageFixture(authority: ReturnType<typeof authorityOf>) {
  const anchor = resolvePackageActivationAnchor(authority.installKey);
  fs.mkdirSync(anchor, { mode: 0o700 });
  const control = resolvePackageActivationControl(anchor);
  fs.mkdirSync(control, { mode: 0o700 });
  const journal = resolvePackageActivationJournalPath(anchor);
  const helper = resolvePackageActivationHelper(anchor);
  const helperSource = "// Inert published-journal fixture, never executed.\n";
  fs.writeFileSync(helper, helperSource, { mode: 0o600 });
  using db = new DatabaseSync(journal);
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
  db.exec(
    "PRAGMA journal_mode=DELETE; CREATE TABLE package_activation (slot INTEGER PRIMARY KEY, revision INTEGER, phase TEXT, descriptor_json TEXT, intent_json TEXT, publications_json TEXT)",
  );
  db.prepare(
    "INSERT INTO package_activation VALUES (1,0,'publication-complete',?,'null','[]')",
  ).run(
    JSON.stringify({
      layout: "external-helper",
      version: 1,
      operationId: randomUUID(),
      authority,
      anchorIdentity: identity(anchor),
      journalIdentity: identity(journal),
      journalParentIdentity: identity(control),
      parentIdentity: identity(path.dirname(anchor)),
      binDir: root,
      binIdentity: identity(root),
      originalStageRoot: candidateRoot,
      previous: fingerprint,
      candidate: { ...fingerprint, identity: identity(candidateRoot) },
      launcherRootIdentity: identity(root),
      previousLauncherRootIdentity: null,
      helperIdentity: identity(helper),
      recoveryNodePath: fs.realpathSync(process.execPath),
      preparation: [
        { name: "anchor" as const, source: anchor },
        { name: "helper" as const, source: helper },
        { name: "candidate" as const, source: candidateRoot },
        { name: "launchers" as const, source: root },
      ].map(({ name, source }) => ({
        name,
        source,
        sourceParentIdentity: identity(path.dirname(source)),
        identity: identity(source),
      })),
      helperDigest: createHash("sha256").update(helperSource).digest("hex"),
      launchers: [],
    } satisfies PackageActivationDescriptor),
  );
}
