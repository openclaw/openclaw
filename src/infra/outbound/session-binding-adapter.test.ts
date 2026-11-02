import { beforeEach, expect, it, vi } from "vitest";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta-read.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveThreadBindingTargetKind } from "./session-binding-adapter.js";

const readSession = vi.hoisted(() =>
  vi.fn<typeof import("../../acp/runtime/session-meta-read.js").readAcpSessionEntryAsync>(),
);
// mock-isolation: Classify prepared metadata without opening session storage or owner admission.
vi.mock("../../acp/runtime/session-meta-read.js", () => ({
  readAcpSessionEntryAsync: readSession,
}));

const params = { cfg: {}, agentId: "ops", channel: "Test", assertCurrent: () => {} };
const session: AcpSessionStoreEntry = {
  cfg: {},
  storePath: "/synthetic/sessions.sqlite",
  sessionKey: "main",
  storeSessionKey: "agent:ops:main",
  acp: {
    backend: "fixture",
    agent: "ops",
    runtimeSessionName: "fixture",
    mode: "persistent",
    state: "idle",
    lastActivityAt: 1,
  },
};
beforeEach(() => readSession.mockReset());

it.each([
  ["agent:ops:acp:binding:configured", "session", "acp"],
  ["agent:ops:acp:binding:configured", "subagent", "subagent"],
] as const)(
  "classifies explicit %s (%s) without session storage",
  async (targetSessionKey, targetKind, expected) => {
    await expect(
      resolveThreadBindingTargetKind({ ...params, targetSessionKey, targetKind }),
    ).resolves.toBe(expected);
    expect(readSession).not.toHaveBeenCalled();
  },
);

it.each(["main", "global", "agent:ops:channel:acp:ordinary"])(
  "uses metadata rather than spelling for %s",
  async (targetSessionKey) => {
    const input = { ...params, targetSessionKey, targetKind: "session" as const };
    readSession.mockResolvedValueOnce(null);
    await expect(resolveThreadBindingTargetKind(input)).resolves.toBe("session");
    readSession.mockResolvedValueOnce(session);
    await expect(resolveThreadBindingTargetKind(input)).resolves.toBe("acp");
    expect(readSession).toHaveBeenLastCalledWith({
      cfg: params.cfg,
      sessionKey: targetSessionKey,
      agentId: "ops",
      assertCurrent: params.assertCurrent,
    });
  },
);

it("refuses an unreadable session store even if legacy ACP metadata exists", async () => {
  readSession.mockResolvedValueOnce({ ...session, storeReadFailed: true });
  await expect(
    resolveThreadBindingTargetKind({ ...params, targetSessionKey: "main", targetKind: "session" }),
  ).rejects.toThrow("retry when session storage is available");
});

it("carries current authority into storage and rejects revocation while the read waits", async () => {
  const entered = createDeferredCore<() => void>();
  const result = createDeferredCore<AcpSessionStoreEntry | null>();
  readSession.mockImplementationOnce(async (input) => {
    entered.resolve(input.assertCurrent!);
    return result.promise;
  });
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("revoked");
    }
  };
  const classification = resolveThreadBindingTargetKind({
    ...params,
    targetSessionKey: "global",
    targetKind: "session",
    assertCurrent,
  });
  const readerAuthority = await entered.promise;
  current = false;
  expect(readerAuthority).toThrow("revoked");
  result.resolve(session);
  await expect(classification).rejects.toThrow("revoked");
});
