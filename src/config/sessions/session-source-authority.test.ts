import { expect, it, vi } from "vitest";
import {
  captureExternalSessionCommitGuard,
  composeSessionSourceAssertion,
  prepareSessionSourceAuthority,
  runWithSessionSourceScope,
} from "./session-source-authority.js";

it.each(["plain", "scoped", "mixed"] as const)(
  "keeps %s source guards at their consumer boundary",
  async (kind) => {
    let guardCurrent = true;
    const guard = vi.fn(() => {
      if (!guardCurrent) {
        throw new Error("consumer guard revoked");
      }
    });
    const release = vi.fn();
    const open = vi.fn(async () => ({ checks: [], assertCurrent() {}, release }));
    const assertion = composeSessionSourceAssertion([
      kind === "scoped" ? undefined : guard,
      kind === "plain" ? undefined : Object.assign(() => {}, { prepareSessionSourceScope: open }),
    ]);
    await runWithSessionSourceScope(assertion, async () => {
      await Promise.resolve();
      assertion();
      if (kind !== "scoped") {
        guardCurrent = false;
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
    let current = true;
    const guard = vi.fn();
    const release = vi.fn();
    const assertion = composeSessionSourceAssertion([
      mixed ? guard : undefined,
      Object.assign(() => {}, {
        prepareSessionSourceScope: async () => ({
          checks: [],
          assertCurrent() {
            if (!current) {
              throw new Error("prepared source revoked");
            }
          },
          release,
        }),
      }),
    ]);
    await expect(
      runWithSessionSourceScope(assertion, async () => {
        assertion();
        await Promise.resolve();
        current = false;
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
    Object.assign(() => {}, {
      prepareSessionSourceScope: async (): Promise<never> => {
        throw failure;
      },
    }),
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
