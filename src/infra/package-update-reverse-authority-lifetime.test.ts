import { afterEach, expect, it, vi } from "vitest";
import type { PackageActivationRecord } from "./package-update-activation-journal.js";
import * as images from "./package-update-activation-reverse-files.js";
import {
  packageActivationReverseBindingSchema,
  type PackageActivationReverseBinding,
} from "./package-update-activation-reverse-schema.js";
import {
  createPackageActivationReverseOwner,
  type PackageReverseAuthority,
} from "./package-update-activation-reverse.js";

// Controlled dependencies isolate callback lifetime, not native executor or
// filesystem admission. No store, worker, process or timer is opened here.
vi.mock("./package-update-reverse-authority.js", () => ({
  capturePackageReverseExecutor: () => ({}),
  assertPackageReverseExecutor: () => ({ installKey: "/fixture/install" }),
}));
vi.mock("./package-update-activation-reverse-binding.js", () => ({
  assertPackageReverseBinding: () => ({}),
  assertPackageReverseTarget: async () => {},
  assertReverseLauncher: async () => {},
  readPackageReverseGenerations: () => ({
    prepared: { databases: [{ role: "global", path: "/fixture/state" }] },
  }),
}));
vi.mock("./package-update-activation-reverse-files.js", () => ({
  assertReverseParents: () => {},
  readPackageReverseImage: vi.fn(),
  syncPackageReverseInputs: async () => {},
}));
afterEach(() => vi.restoreAllMocks());

function fixture(phase: "rolled-back" | "reverse-complete") {
  const resources = [
    {
      role: "package",
      live: "/fixture/install",
      parentIdentity: "1:1",
      before: { kind: "package", identity: "1:4" },
      after: { kind: "package", identity: "1:2" },
      move: {
        staged: "/fixture/staged",
        displaced: "/fixture/displaced",
        stagedParentIdentity: "1:1",
        displacedParentIdentity: "1:1",
      },
    },
    {
      role: "state",
      live: "/fixture/state",
      parentIdentity: "1:1",
      before: { kind: "file", identity: "1:3" },
      after: { kind: "file", identity: "1:3" },
      move: null,
    },
  ];
  // Schema validity is covered by the journal tests. This boundary deliberately
  // supplies the already-parsed record to expose only callback replacement.
  const binding = {
    runId: "original",
    operationId: "operation",
    resources,
  } as PackageActivationReverseBinding;
  vi.spyOn(packageActivationReverseBindingSchema, "parse").mockImplementation(() => binding);
  vi.mocked(images.readPackageReverseImage).mockImplementation(async (file) => {
    const resource = resources.find(
      (r) => r.live === file || r.move?.staged === file || r.move?.displaced === file,
    )!;
    return (
      resource.move?.staged === file
        ? { kind: "missing" }
        : resource.move?.displaced === file
          ? resource.before
          : resource.after
    ) as (typeof binding.resources)[number]["after"];
  });
  let record = {
    phase,
    descriptor: {
      originalRunId: "original",
      authority: { installKey: "/fixture/install" },
      reverse: binding,
      launchers: [],
    },
    intent: { kind: "reverse", direction: "reverse", completed: 2, effect: null },
  } as unknown as PackageActivationRecord;
  let release!: () => void;
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const suspended = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transition = vi.fn((next: PackageActivationRecord["phase"]) => {
    record = { ...record, phase: next };
  });
  const owner = createPackageActivationReverseOwner({
    current: () => record,
    journal: { assertCurrent: () => {} } as unknown as Parameters<
      typeof createPackageActivationReverseOwner
    >[0]["journal"],
    transition,
    prepareReverse: () => {},
    sealReverse: () => {},
    assertCurrent: () => {},
    verifyForward: async () => {},
    verifyClosure: async () => {
      reached();
      await suspended;
    },
    executor: {} as NonNullable<
      Parameters<typeof createPackageActivationReverseOwner>[0]["executor"]
    >,
  });
  let active = true;
  const original = vi.fn(() => {
    if (!active) {
      throw new Error("original maintenance closed");
    }
  });
  const guard: PackageReverseAuthority = {
    assertCurrent: original,
    assertWritersSettled: original,
    validateTarget: async () => {},
    beforeStatePublication: () => {},
  };
  return {
    owner,
    binding,
    guard,
    original,
    waiting,
    release,
    transition,
    record: () => record,
    revoke: () => {
      active = false;
    },
  };
}

it.each(["completion", "settlement"] as const)(
  "retains original callbacks through awaited %s inspection",
  async (operation) => {
    const f = fixture(operation === "completion" ? "rolled-back" : "reverse-complete");
    const pending =
      operation === "completion"
        ? f.owner.verifyCompletion(f.binding, f.guard)
        : f.owner.settleReverse(f.guard);
    const replacement = vi.fn();
    // Attach the expected rejection before releasing the controlled await.
    const rejected = expect(pending).rejects.toThrow("original maintenance closed");
    await f.waiting;
    f.guard.assertCurrent = replacement;
    f.guard.assertWritersSettled = replacement;
    f.revoke();
    f.release();
    await rejected;
    expect(replacement).not.toHaveBeenCalled();
    expect(f.transition).not.toHaveBeenCalled();
    expect(f.record().phase).toBe(operation === "completion" ? "rolled-back" : "reverse-complete");
  },
);

it.each(["completion", "settlement"] as const)(
  "finishes %s with its original still-live maintenance",
  async (operation) => {
    const f = fixture(operation === "completion" ? "rolled-back" : "reverse-complete");
    const pending =
      operation === "completion"
        ? f.owner.verifyCompletion(f.binding, f.guard)
        : f.owner.settleReverse(f.guard);
    await f.waiting;
    f.release();
    const result = await pending;
    expect(result.phase).toBe(operation === "completion" ? "rolled-back" : "reverse-complete");
    if (operation === "completion") {
      expect(result).toMatchObject({
        publishedState: {
          state: { databasePath: "/fixture/state", databaseIdentity: "1:3", parentIdentity: "1:1" },
        },
      });
      expect(f.transition).not.toHaveBeenCalled();
    } else {
      expect(f.transition).toHaveBeenCalledOnce();
      expect(f.record().phase).toBe("reverse-complete");
    }
  },
);
