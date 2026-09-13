import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import type { TriageBackingReference } from "./triage-backing.js";
import { continueTriageInFreshProcess } from "./triage-continuation.js";
import { triageTestRuntimeEntrypoints } from "./triage-runtime.test-support.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function fixture(mode: "closed" | "uncertain" | "nonzero") {
  const root = fs.realpathSync(dirs.make("triage-parent-result-"));
  const continuation = resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.continuation);
  const entry = path.join(root, "dist/index.js");
  const admitted = path.join(root, "admitted.json");
  const finish = path.join(root, "finish");
  const finished = path.join(root, "finished");
  const exit = path.join(root, "exit");
  fs.mkdirSync(path.dirname(entry));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","type":"module"}');
  fs.writeFileSync(
    entry,
    `
import fs from "node:fs";
import { acceptTriageContinuation } from ${JSON.stringify(continuation.href)};
const admission = await acceptTriageContinuation();
admission.assertCurrent();
fs.writeFileSync(${JSON.stringify(admitted)}, JSON.stringify(admission.backing));
const wait = file => new Promise(resolve => {
  const timer = setInterval(() => {
    if (fs.existsSync(file) || admission.signal.aborted) {
      clearInterval(timer);
      resolve();
    }
  }, 10);
});
await wait(${JSON.stringify(finish)});
process.stdout.write(JSON.stringify({
  installationRoot: "/not-the-admitted-root",
  generationOwner: "child-supplied-owner",
  repair: { status: "incomplete", finalValidation: { ok: false } }
}));
await admission.finish(${JSON.stringify(mode === "uncertain" ? "uncertain" : "closed")});
fs.writeFileSync(${JSON.stringify(finished)}, "");
// Keep a real handle open after child finish. Parent completion must still wait for drain.
await new Promise(resolve => {
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(exit)})) {
      clearInterval(timer);
      resolve();
    }
  }, 10);
});
process.exitCode = ${mode === "nonzero" ? 7 : 0};
`,
  );
  const controller = new AbortController();
  const operation = () =>
    continueTriageInFreshProcess({
      root,
      commandArgv: [process.execPath, entry, "triage"],
      operator: { kind: "operator", installationRoot: root, gateway: "preserve" },
      signal: controller.signal,
      output: () => {},
    });
  return { root, admitted, finish, finished, exit, controller, operation };
}

it("returns the parent's admitted correlation only after child close and release, never from stdout", async () => {
  const f = fixture("closed");
  const store = createManagedHandoffLeaseStore();
  let settled = false;
  const run = f.operation().finally(() => {
    settled = true;
  });
  try {
    await vi.waitFor(() => expect(fs.existsSync(f.admitted)).toBe(true), { timeout: 25000 });
    const backing = JSON.parse(fs.readFileSync(f.admitted, "utf8")) as TriageBackingReference;
    fs.writeFileSync(f.finish, "");
    await vi.waitFor(() => expect(fs.existsSync(f.finished)).toBe(true), { timeout: 10000 });
    const beforeExit = store.read(f.root);
    expect(beforeExit.kind).toBe("current");
    if (beforeExit.kind !== "current") {
      throw new Error("fixture lost the admitted lease before child exit");
    }
    expect(beforeExit.lease.owner).toBe(backing.generation.owner);
    expect(beforeExit.lease.action).toMatchObject({ kind: "triage", phase: "closed" });
    expect(settled).toBe(false);
    fs.writeFileSync(f.exit, "");
    const outcome = await run;
    expect(outcome).toMatchObject({
      status: "completed",
      installationRoot: f.root,
      generationOwner: backing.generation.owner,
    });
    expect(store.read(f.root).kind).toBe("absent");
    if (outcome.status !== "completed" || outcome.commandOutput.kind !== "complete") {
      throw new Error("missing bounded parent output");
    }
    expect(JSON.parse(outcome.commandOutput.stdout)).toMatchObject({
      installationRoot: "/not-the-admitted-root",
      generationOwner: "child-supplied-owner",
      repair: { status: "incomplete", finalValidation: { ok: false } },
    });
    expect(outcome).not.toHaveProperty("repair");
  } finally {
    fs.writeFileSync(f.finish, "");
    fs.writeFileSync(f.exit, "");
    f.controller.abort();
    await run.catch(() => {});
  }
}, 40000);

it.each(["uncertain", "nonzero"] as const)(
  "withholds parent completion correlation after %s child settlement",
  async (mode) => {
    const f = fixture(mode);
    // Attach the rejection handler immediately so an early child error is preserved.
    const result = f.operation().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await vi.waitFor(() => expect(fs.existsSync(f.admitted)).toBe(true), { timeout: 25000 });
      fs.writeFileSync(f.finish, "");
      await vi.waitFor(() => expect(fs.existsSync(f.finished)).toBe(true), { timeout: 10000 });
      fs.writeFileSync(f.exit, "");
      const outcome = await result;
      expect(outcome).not.toHaveProperty("value");
      expect("error" in outcome ? String(outcome.error) : "").toContain(
        mode === "uncertain" ? "cleanup is uncertain" : "failed (exit 7)",
      );
      const remaining = createManagedHandoffLeaseStore().read(f.root);
      if (mode === "uncertain") {
        expect(remaining.kind).toBe("current");
        if (remaining.kind === "current") {
          expect(remaining.lease.action).toMatchObject({ kind: "triage", phase: "uncertain" });
        }
      } else {
        expect(remaining.kind).toBe("absent");
      }
    } finally {
      fs.writeFileSync(f.finish, "");
      fs.writeFileSync(f.exit, "");
      f.controller.abort();
      await result;
    }
  },
  40000,
);

it("keeps busy admission visibly not-running without a completion correlation", async () => {
  const f = fixture("closed");
  const store = createManagedHandoffLeaseStore();
  const reserved = store.acquire(f.root, "existing-owner", {
    kind: "triage",
    phase: "reserved",
    lifetime: { kind: "foreground", boot: store.bootIdentity() },
  });
  if (reserved.kind !== "acquired") {
    throw new Error("fixture could not reserve root");
  }
  try {
    expect(await f.operation()).toEqual({ status: "not-running", reason: "busy" });
    expect(fs.existsSync(f.admitted)).toBe(false);
    expect(store.read(f.root)).toEqual({ kind: "current", lease: reserved.lease });
  } finally {
    expect(store.release(reserved.lease)).toBe(true);
  }
});
