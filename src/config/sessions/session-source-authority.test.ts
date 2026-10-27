import { expect, it, vi } from "vitest";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  prepareSessionSourceAuthority,
  runWithSessionSourceScope,
  type SessionSourceAssertion,
  type PreparedSessionSourceAuthority,
} from "./session-source-authority.js";

const sourceWith = (methods: Partial<SessionSourceAssertion>) => Object.assign(() => {}, methods);

it("prepares empty predicates without allocating intermediate mapped arrays", async () => {
  const live = revocable("source revoked after preparation");
  const checks: PreparedSessionSourceAuthority["checks"] = [];
  const map = vi.spyOn(checks, "map");
  const assertion = composeSessionSourceAssertion([
    sourceWith({ prepareSessionSource: async () => ({ checks, ...live }) }),
  ]);
  const prepared = await assertion.prepareSessionSource();
  expect(prepared.checks).toEqual([]);
  expect(map).not.toHaveBeenCalled();
  prepared.assertCurrent();
  prepared.assertPreparedCurrent?.();
  live.revoke();
  expect(prepared.assertCurrent).toThrow("source revoked after preparation");
  expect(prepared.assertPreparedCurrent).toThrow("source revoked after preparation");
});

function revocable(message: string) {
  const controller = new AbortController();
  return {
    revoke: () => controller.abort(new Error(message)),
    assertCurrent: vi.fn(() => controller.signal.throwIfAborted()),
  };
}

it.each(["plain", "scoped", "mixed"] as const)(
  "keeps %s source guards at their consumer boundary",
  async (kind) => {
    const { assertCurrent: guard, revoke } = revocable("consumer guard revoked");
    const release = vi.fn();
    const open = vi.fn(async () => ({ checks: [], assertCurrent() {}, release }));
    const assertion = composeSessionSourceAssertion([
      kind === "scoped" ? undefined : guard,
      kind === "plain" ? undefined : sourceWith({ prepareSessionSourceScope: open }),
    ]);
    await runWithSessionSourceScope(assertion, async () => {
      await Promise.resolve();
      assertion();
      if (kind !== "scoped") {
        revoke();
        expect(assertion).toThrow("consumer guard revoked");
      }
    });
    expect(guard).toHaveBeenCalledTimes(kind === "scoped" ? 0 : 2);
    expect(open).toHaveBeenCalledTimes(kind === "plain" ? 0 : 1);
    expect(release).toHaveBeenCalledTimes(kind === "plain" ? 0 : 1);
  },
);

it.each([false, true])(
  "revalidates prepared facts and releases them without rerunning a plain guard (mixed=%s)",
  async (mixed) => {
    const prepared = revocable("prepared source revoked");
    const guard = vi.fn();
    const release = vi.fn();
    const assertion = composeSessionSourceAssertion([
      mixed ? guard : undefined,
      sourceWith({ prepareSessionSourceScope: async () => ({ checks: [], ...prepared, release }) }),
    ]);
    await expect(
      runWithSessionSourceScope(assertion, async () => {
        assertion();
        await Promise.resolve();
        prepared.revoke();
      }),
    ).rejects.toThrow("prepared source revoked");
    expect(guard).toHaveBeenCalledTimes(mixed ? 1 : 0);
    expect(release).toHaveBeenCalledOnce();
  },
);

it("preserves a scoped acquisition failure without invoking its plain sibling guard", async () => {
  const guard = vi.fn();
  const failure = new Error("source acquisition failed");
  const assertion = composeSessionSourceAssertion([
    guard,
    sourceWith({ prepareSessionSourceScope: () => Promise.reject(failure) }),
  ]);
  await expect(runWithSessionSourceScope(assertion, async () => {})).rejects.toBe(failure);
  expect(guard).not.toHaveBeenCalled();
});

it("keeps native opacity and full checks on transaction source preparation", async () => {
  const plain = vi.fn();
  const external = vi.fn();
  const assertion = composeSessionSourceAssertion([
    plain,
    captureExternalSessionCommitGuard(external),
  ]);
  const prepared = await prepareSessionSourceAuthority(assertion);
  expect(prepared.nativeSource).toBe(true);
  prepared.assertPreparedCurrent?.();
  expect(plain).toHaveBeenCalledOnce();
  expect(external).not.toHaveBeenCalled();
  prepared.assertCurrent();
  expect(plain).toHaveBeenCalledTimes(2);
  expect(external).toHaveBeenCalledOnce();
});

it("retains every composed source until accepted work releases its hold", () => {
  let references = 1;
  const source = Object.assign(
    () => {
      if (references === 0) {
        throw new Error("source released");
      }
    },
    {
      retain: () => {
        references++;
        return () => references--;
      },
    },
  );
  const assertion = composeSessionSourceAssertion([composeSessionSourceAssertion([source])]);
  const release = assertion.retain!();
  references--;
  expect(assertion).not.toThrow();
  release();
  release();
  expect(assertion).toThrow("source released");
});

it("releases earlier source holds when a later acquisition fails", () => {
  const release = vi.fn();
  const assertion = composeSessionSourceAssertion([
    sourceWith({ retain: () => release }),
    sourceWith({
      retain: () => {
        throw new Error("source released");
      },
    }),
  ]);
  expect(() => assertion.retain!()).toThrow("source released");
  expect(release).toHaveBeenCalledOnce();
});
