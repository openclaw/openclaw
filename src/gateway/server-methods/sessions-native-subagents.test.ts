import { expect, it, vi } from "vitest";
import type { NativeSubagentsSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import {
  identifiedClient,
  initializeSessionReadContext,
  requestContext,
  sessionReadHandlers,
} from "./sessions-read-cache.test-support.js";
import type { RespondFn } from "./types.js";

const key = "agent:main:dashboard:native-roster";
const scope = { agentId: "main", sessionKey: key };
const snapshot: NativeSubagentsSnapshot = {
  coverage: "live",
  children: [{ id: "native-thread", label: "/root/audit", status: "running" }],
  truncated: false,
};

async function withFixture(
  run: (fixture: {
    describe: (include?: boolean, otherViewer?: boolean) => Promise<Parameters<RespondFn>>;
    observe: ReturnType<typeof vi.fn<NonNullable<AgentHarness["readNativeSubagents"]>>>;
    replace: () => Promise<void>;
    hide: () => Promise<void>;
  }) => Promise<void>,
  others: "none" | "view" = "none",
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: {
        roles: {
          default: "reader",
          definitions: {
            reader: { agents: "*", scopes: ["operator.read"], sessions: { others } },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    setActivePluginRegistry(createEmptyPluginRegistry());
    const observe = vi.fn<NonNullable<AgentHarness["readNativeSubagents"]>>(async () => snapshot);
    registerAgentHarness({
      id: "native-roster",
      label: "Synthetic native runtime",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("Observation must not execute");
      },
      readNativeSubagents: observe,
    });
    const owner = ensureProfileForEmail("native-owner@example.test").id;
    const other = ensureProfileForEmail("native-other@example.test").id;
    const put = (sessionId: string) =>
      upsertSessionEntryCore(scope, {
        sessionId,
        updatedAt: Date.now(),
        agentHarnessId: "native-roster",
        visibility: "read-only",
        createdActor: { type: "human", source: "profile", id: owner },
      });
    await put("parent-original");
    const context = requestContext(cfg);
    const viewers = [identifiedClient(owner), identifiedClient(other)] as const;
    await initializeSessionReadContext(context);
    try {
      await run({
        observe,
        hide: async () => {
          await upsertSessionEntryCore(scope, { visibility: "draft" });
        },
        replace: async () => {
          await put("parent-replaced");
        },
        describe: async (include = true, otherViewer = false) => {
          const responses: Parameters<RespondFn>[] = [];
          const params = { key, ...(include ? { includeNativeSubagents: true } : {}) };
          await sessionReadHandlers["sessions.describe"]!({
            req: { type: "req", id: "native-observation", method: "sessions.describe" },
            params,
            context,
            client: viewers[otherViewer ? 1 : 0],
            isWebchatConnect: () => false,
            respond: (...response) => responses.push(response),
          });
          expect(responses).toHaveLength(1);
          return responses[0]!;
        },
      });
    } finally {
      getSessionRowProjection(context)?.dispose();
    }
  });
}

it("exposes native observations only on an authorized explicit parent read", () =>
  withFixture(async (f) => {
    const ordinary = await f.describe(false);
    expect(ordinary[0]).toBe(true);
    expect(ordinary[1]).not.toHaveProperty("nativeSubagents");
    expect(f.observe).not.toHaveBeenCalled();
    const allowed = await f.describe();
    expect(allowed[0]).toBe(true);
    expect(allowed[1]).toMatchObject({
      session: { sessionId: "parent-original" },
      nativeSubagents: {
        ...snapshot,
        children: [{ ...snapshot.children[0], id: "native-roster:native-thread" }],
      },
    });
    f.observe.mockClear();
    const denied = await f.describe(true, true);
    expect(denied[1]).not.toHaveProperty("nativeSubagents");
    expect(f.observe).not.toHaveBeenCalled();
  }));

it.each(["session", "harness"])(
  "discards observations when the %s changes during the read",
  (change) =>
    withFixture(async (f) => {
      const release = createDeferredCore();
      f.observe.mockImplementation(async () => {
        await release.promise;
        return snapshot;
      });
      const pending = f.describe();
      try {
        await vi.waitFor(() => expect(f.observe).toHaveBeenCalledOnce());
        if (change === "session") {
          await f.replace();
        } else {
          setActivePluginRegistry(createEmptyPluginRegistry());
        }
      } finally {
        release.resolve();
      }
      const result = await pending;
      expect(result[0]).toBe(false);
      expect(result[1]).toBeUndefined();
    }),
);

it("withdraws native observations when parent sharing is revoked during the read", () =>
  withFixture(async (f) => {
    const release = createDeferredCore();
    f.observe.mockImplementation(async () => {
      await release.promise;
      return snapshot;
    });
    const pending = f.describe(true, true);
    try {
      await vi.waitFor(() => expect(f.observe).toHaveBeenCalledOnce());
      await f.hide();
    } finally {
      release.resolve();
    }
    const result = await pending;
    expect(result[1] ?? {}).not.toHaveProperty("nativeSubagents");
    expect(JSON.stringify(result)).not.toContain("/root/audit");
  }, "view"));
