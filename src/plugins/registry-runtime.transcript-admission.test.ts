import { describe, expect, it, vi } from "vitest";
import type { SessionTranscriptAdmissionSnapshot } from "../config/sessions/session-transcript-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createPluginRecord } from "./loader-records.js";
import { revokePluginRecord } from "./registry-lifecycle.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { createPluginRuntime } from "./runtime/index.js";

function fixture() {
  const runtime = createPluginRuntime();
  // This transport-only token never enters the real transcript owner.
  const token = Object.freeze({}) as SessionTranscriptAdmissionSnapshot["token"];
  const snapshot: SessionTranscriptAdmissionSnapshot = {
    kind: "snapshot",
    entries: [],
    generation: null,
    boundary: null,
    token,
  };
  runtime.agent.session.readTranscriptAdmission = vi.fn(async () => snapshot);
  const accept = vi.fn();
  runtime.agent.session.acceptTranscriptAdmission = async (_token, commit) => {
    accept();
    return { kind: "accepted", value: await commit(null) };
  };
  const builder = createRuntimeTestRegistry(runtime);
  const record = createPluginRecord({
    id: "consumer",
    source: "/plugins/consumer/index.js",
    origin: "workspace",
    enabled: true,
    configSchema: false,
  });
  const api = builder.createApi(record, { config: {} });
  const sibling = builder.createApi(
    createPluginRecord({
      id: "sibling",
      source: "/plugins/sibling/index.js",
      origin: "workspace",
      enabled: true,
      configSchema: false,
    }),
    { config: {} },
  );
  return { runtime, builder, record, api, sibling, snapshot, accept };
}
const target = { agentId: "main", sessionId: "session", sessionKey: "agent:main:session" };

describe("plugin-bound transcript acceptance", () => {
  it("does not accept another plugin's token or duplicate acceptance", async () => {
    const { api, sibling, accept } = fixture();
    const snapshot = await api.runtime.agent.session.readTranscriptAdmission(target);
    if (snapshot.kind !== "snapshot") {
      throw new Error("expected snapshot");
    }
    const commit = vi.fn(() => 42);
    expect(
      await sibling.runtime.agent.session.acceptTranscriptAdmission(snapshot.token, commit),
    ).toEqual({ kind: "stale" });
    expect(accept).not.toHaveBeenCalled();
    expect(
      await api.runtime.agent.session.acceptTranscriptAdmission(snapshot.token, commit),
    ).toEqual({ kind: "accepted", value: 42 });
    expect(
      await api.runtime.agent.session.acceptTranscriptAdmission(snapshot.token, commit),
    ).toEqual({ kind: "stale" });
    expect(commit).toHaveBeenCalledOnce();
  });
  it("rejects a read completed after plugin revocation", async () => {
    const { runtime, api, builder, record, snapshot } = fixture();
    const read = createDeferredCore<SessionTranscriptAdmissionSnapshot>();
    runtime.agent.session.readTranscriptAdmission = vi.fn(() => read.promise);
    const pending = api.runtime.agent.session.readTranscriptAdmission(target);
    revokePluginRecord(builder.registry, record);
    read.resolve(snapshot);
    await expect(pending).rejects.toThrow("no longer active");
  });
  it("rechecks plugin authority when host acceptance reaches the persistence callback", async () => {
    const { runtime, api, builder, record } = fixture();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    runtime.agent.session.acceptTranscriptAdmission = async (_token, commit) => {
      entered.resolve();
      await release.promise;
      return { kind: "accepted", value: await commit(null) };
    };
    const snapshot = await api.runtime.agent.session.readTranscriptAdmission(target);
    if (snapshot.kind !== "snapshot") {
      throw new Error("expected snapshot");
    }
    const commit = vi.fn();
    const pending = api.runtime.agent.session.acceptTranscriptAdmission(snapshot.token, commit);
    await entered.promise;
    revokePluginRecord(builder.registry, record);
    release.resolve();
    await expect(pending).rejects.toThrow("no longer active");
    expect(commit).not.toHaveBeenCalled();
  });
});
