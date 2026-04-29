import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  resetAgentRunContextForTest,
} from "../../infra/agent-events.js";
import {
  clearPluginHostRuntimeState,
  createHostRunContextGetter,
  getPluginRunContext,
  resolveHostRunContextSnapshot,
  setPluginRunContext,
} from "../host-hook-runtime.js";
import { HOST_RUNTIME_NAMESPACE, type HostRuntimeRunContext } from "../host-runtime-namespace.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";

describe("host runtime sync reads", () => {
  beforeEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    resetAgentRunContextForTest();
  });

  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    clearPluginHostRuntimeState();
    resetAgentRunContextForTest();
  });

  describe("getHostRunContext snapshot", () => {
    it("returns undefined when the run id is not registered", () => {
      expect(resolveHostRunContextSnapshot("missing-run", HOST_RUNTIME_NAMESPACE)).toBeUndefined();
    });

    it("returns undefined when the run id is missing entirely", () => {
      expect(resolveHostRunContextSnapshot(undefined, HOST_RUNTIME_NAMESPACE)).toBeUndefined();
    });

    it("returns an empty subagent list for a freshly registered run", () => {
      registerAgentRunContext("run-empty", { sessionKey: "session-1" });
      expect(resolveHostRunContextSnapshot("run-empty", HOST_RUNTIME_NAMESPACE)).toEqual({
        openSubagentRunIds: [],
      });
    });

    it("tracks open subagents when their parentRunId points at a known parent", () => {
      registerAgentRunContext("run-parent", { sessionKey: "session-parent" });
      registerAgentRunContext("run-child-a", {
        sessionKey: "session-child-a",
        parentRunId: "run-parent",
      });
      registerAgentRunContext("run-child-b", {
        sessionKey: "session-child-b",
        parentRunId: "run-parent",
      });

      const snapshot = resolveHostRunContextSnapshot("run-parent", HOST_RUNTIME_NAMESPACE);
      expect(snapshot?.openSubagentRunIds).toEqual(["run-child-a", "run-child-b"]);
      expect(snapshot?.parentRunId).toBeUndefined();
      expect(snapshot?.lastSubagentSettledAt).toBeUndefined();
    });

    it("exposes the parentRunId on the child snapshot", () => {
      registerAgentRunContext("run-parent", { sessionKey: "session-parent" });
      registerAgentRunContext("run-child", {
        sessionKey: "session-child",
        parentRunId: "run-parent",
      });
      expect(resolveHostRunContextSnapshot("run-child", HOST_RUNTIME_NAMESPACE)?.parentRunId).toBe(
        "run-parent",
      );
    });

    it("removes a subagent from openSubagentRunIds and stamps lastSubagentSettledAt on clear", () => {
      registerAgentRunContext("run-parent", { sessionKey: "session-parent" });
      registerAgentRunContext("run-child", {
        sessionKey: "session-child",
        parentRunId: "run-parent",
      });
      const before = resolveHostRunContextSnapshot("run-parent", HOST_RUNTIME_NAMESPACE);
      expect(before?.openSubagentRunIds).toEqual(["run-child"]);

      clearAgentRunContext("run-child");

      const after = resolveHostRunContextSnapshot("run-parent", HOST_RUNTIME_NAMESPACE);
      expect(after?.openSubagentRunIds).toEqual([]);
      expect(typeof after?.lastSubagentSettledAt).toBe("number");
    });

    it("returns a fresh snapshot on every call so callers cannot mutate live state", () => {
      registerAgentRunContext("run-parent", { sessionKey: "session-parent" });
      registerAgentRunContext("run-child", {
        sessionKey: "session-child",
        parentRunId: "run-parent",
      });
      const first = resolveHostRunContextSnapshot(
        "run-parent",
        HOST_RUNTIME_NAMESPACE,
      ) as HostRuntimeRunContext;
      // Try to mutate the returned list — the live state must not change.
      (first.openSubagentRunIds as unknown as string[]).push("forged");
      const second = resolveHostRunContextSnapshot("run-parent", HOST_RUNTIME_NAMESPACE);
      expect(second?.openSubagentRunIds).toEqual(["run-child"]);
    });

    it("does not let a duplicate registration overwrite an existing parentRunId", () => {
      registerAgentRunContext("run-parent-original", { sessionKey: "session-original" });
      registerAgentRunContext("run-child", {
        sessionKey: "session-child",
        parentRunId: "run-parent-original",
      });
      // A later re-registration (e.g. live model switch) tries to claim a
      // different parent — the original linkage must win.
      registerAgentRunContext("run-child", {
        sessionKey: "session-child",
        parentRunId: "run-parent-other",
      });
      expect(getAgentRunContext("run-child")?.parentRunId).toBe("run-parent-original");
    });

    it("throws when the namespace is not the canonical host one", () => {
      expect(() => resolveHostRunContextSnapshot("run-x", "_host.future" as any)).toThrowError(
        /unknown host run-context namespace/,
      );
    });

    it("createHostRunContextGetter returns a getter bound to the run id", () => {
      registerAgentRunContext("run-getter", { sessionKey: "session-getter" });
      registerAgentRunContext("run-getter-child", {
        sessionKey: "session-getter-child",
        parentRunId: "run-getter",
      });
      const getter = createHostRunContextGetter("run-getter");
      expect(getter(HOST_RUNTIME_NAMESPACE)?.openSubagentRunIds).toEqual(["run-getter-child"]);
    });

    it("createHostRunContextGetter returns undefined when no run id is in scope", () => {
      const getter = createHostRunContextGetter(undefined);
      expect(getter(HOST_RUNTIME_NAMESPACE)).toBeUndefined();
    });
  });

  describe("_host.* namespace write protection", () => {
    it("rejects setPluginRunContext writes for any _host.* namespace", () => {
      registerAgentRunContext("run-write", { sessionKey: "session-write" });
      expect(
        setPluginRunContext({
          pluginId: "rogue",
          patch: {
            runId: "run-write",
            namespace: "_host.runtime",
            value: { openSubagentRunIds: [] },
          },
        }),
      ).toBe(false);
      expect(
        setPluginRunContext({
          pluginId: "rogue",
          patch: {
            runId: "run-write",
            namespace: "_host.future",
            value: { ok: true },
          },
        }),
      ).toBe(false);
    });

    it("returns undefined when a plugin reads a _host.* namespace via getPluginRunContext", () => {
      registerAgentRunContext("run-read", { sessionKey: "session-read" });
      expect(
        getPluginRunContext({
          pluginId: "any",
          get: { runId: "run-read", namespace: "_host.runtime" },
        }),
      ).toBeUndefined();
    });

    it("still accepts non-reserved namespace writes from plugins", () => {
      registerAgentRunContext("run-ok", { sessionKey: "session-ok" });
      expect(
        setPluginRunContext({
          pluginId: "ok",
          patch: { runId: "run-ok", namespace: "workflow", value: { state: "ready" } },
        }),
      ).toBe(true);
      expect(
        getPluginRunContext({
          pluginId: "ok",
          get: { runId: "run-ok", namespace: "workflow" },
        }),
      ).toEqual({ state: "ready" });
    });
  });
});
