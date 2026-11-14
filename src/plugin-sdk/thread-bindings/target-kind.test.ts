import { beforeEach, expect, it, vi } from "vitest";
import type { AcpSessionStoreEntry } from "../../acp/runtime/session-meta-read.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveThreadBindingTargetKind } from "./target-kind.js";

const readSession = vi.hoisted(() =>
  vi.fn<typeof import("../../acp/runtime/session-meta-read.js").readAcpSessionEntryAsync>(),
);
// mock-isolation: Classify prepared metadata without opening session storage or owner admission.
vi.mock("../../acp/runtime/session-meta-read.js", () => ({
  readAcpSessionEntryAsync: readSession,
}));

const params = { cfg: {}, agentId: "ops", channel: "Test", assertCurrent: () => {} };
const pluginMetadata = {
  pluginBindingOwner: "plugin",
  pluginId: "fixture-runtime",
  pluginRoot: "/plugins/fixture-runtime",
};
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
      resolveThreadBindingTargetKind({
        ...params,
        targetSessionKey,
        targetKind,
        metadata: pluginMetadata,
      }),
    ).resolves.toBe(expected);
    expect(readSession).not.toHaveBeenCalled();
  },
);

it.each(["plugin-binding:fixture-runtime:opaque", "external-runtime:opaque"])(
  "classifies plugin-owned %s without selecting an agent or reading session storage",
  async (targetSessionKey) => {
    await expect(
      resolveThreadBindingTargetKind({
        ...params,
        cfg: { agents: { entries: { alpha: {}, beta: {} } } },
        agentId: undefined,
        targetSessionKey,
        targetKind: "session",
        metadata: pluginMetadata,
      }),
    ).resolves.toBe("session");
    expect(readSession).not.toHaveBeenCalled();
  },
);

it.each([
  undefined,
  { pluginBindingOwner: "plugin" },
  { pluginBindingOwner: "plugin", pluginId: "fixture-runtime" },
])(
  "does not bypass session storage for an opaque prefix or incomplete plugin metadata: %j",
  async (metadata) => {
    readSession.mockResolvedValueOnce(session);
    await expect(
      resolveThreadBindingTargetKind({
        ...params,
        agentId: undefined,
        targetSessionKey: "plugin-binding:fixture-runtime:unowned",
        targetKind: "session",
        metadata,
      }),
    ).resolves.toBe("acp");
    expect(readSession).toHaveBeenCalledOnce();
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
