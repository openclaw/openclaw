import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveRuntimeConversationBindingRouteAsync } from "../../channels/plugins/binding-routing.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { openNodeSqliteDatabase, requireNodeSqlite } from "../node-sqlite.js";
import {
  createAccountScopedConversationBindingManager,
  resetAccountScopedConversationBindingsForTests,
} from "./account-scoped-conversation-bindings.js";
import { getSessionBindingService, testing } from "./session-binding-service.js";

const methods = ["construct", "close", "prepare", "exec", "get", "all", "run", "iterate"] as const;
type SqliteCounts = Record<(typeof methods)[number], number>;
const emptyCounts = (): SqliteCounts => ({
  construct: 0,
  close: 0,
  prepare: 0,
  exec: 0,
  get: 0,
  all: 0,
  run: 0,
  iterate: 0,
});

function observeParentSqlite() {
  const sqlite = requireNodeSqlite();
  const { DatabaseSync, StatementSync } = sqlite;
  const counts = emptyCounts();
  const restores: Array<() => void> = [];
  const constructor = Object.getOwnPropertyDescriptor(sqlite, "DatabaseSync");
  if (!constructor?.writable || constructor.value !== DatabaseSync) {
    throw new Error("All eight parent SQLite counters require a writable constructor");
  }
  Object.defineProperty(sqlite, "DatabaseSync", {
    ...constructor,
    value: new Proxy(DatabaseSync, {
      construct(target, args, newTarget) {
        counts.construct += 1;
        return Reflect.construct(target, args, newTarget);
      },
    }),
  });
  restores.push(() => Object.defineProperty(sqlite, "DatabaseSync", constructor));
  try {
    for (const [prototype, names] of [
      [DatabaseSync.prototype, ["close", "prepare", "exec"]],
      [StatementSync.prototype, ["get", "all", "run", "iterate"]],
    ] as const) {
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (!descriptor?.writable || typeof descriptor.value !== "function") {
          throw new Error(`Parent SQLite counter unavailable: ${name}`);
        }
        Object.defineProperty(prototype, name, {
          ...descriptor,
          value(this: unknown, ...args: unknown[]) {
            counts[name] += 1;
            return Reflect.apply(descriptor.value, this, args);
          },
        });
        restores.push(() => Object.defineProperty(prototype, name, descriptor));
      }
    }
    return {
      counts,
      reset: () => Object.assign(counts, emptyCounts()),
      restore: () => restores.toReversed().forEach((restore) => restore()),
    };
  } catch (error) {
    restores.toReversed().forEach((restore) => restore());
    throw error;
  }
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const stateKey = Symbol("binding-routing-worker-proof");
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-binding-route-worker-"));
  testing.resetSessionBindingAdaptersForTests();
});
afterEach(async () => {
  resetAccountScopedConversationBindingsForTests({ stateKey });
  testing.resetSessionBindingAdaptersForTests();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

describe("awaited conversation routing storage ownership", () => {
  it.each(["generic", "account"] as const)(
    "routes and records activity for %s bindings without parent SQLite calls",
    async (kind) => {
      const channel = kind === "generic" ? "webchat" : "imessage";
      const conversation = { channel, accountId: "default", conversationId: "worker-route" };
      const service = getSessionBindingService();
      const route: ResolvedAgentRoute = {
        agentId: "main",
        channel,
        accountId: "default",
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "main",
        matchedBy: "default",
      };
      const observer = observeParentSqlite();
      try {
        const calibration = openNodeSqliteDatabase(":memory:");
        calibration.exec("CREATE TABLE calibration (value INTEGER)");
        calibration.prepare("INSERT INTO calibration VALUES (?)").run(7);
        const query = calibration.prepare("SELECT value FROM calibration");
        expect(query.get()).toEqual({ value: 7 });
        expect(query.all()).toEqual([{ value: 7 }]);
        expect([...query.iterate()]).toEqual([{ value: 7 }]);
        calibration.close();
        for (const method of methods) {
          expect(observer.counts[method], `${method} calibration`).toBeGreaterThan(0);
        }
        observer.reset();
        if (kind === "account") {
          createAccountScopedConversationBindingManager({
            channel,
            accountId: "default",
            cfg: { session: { threadBindings: { idleHours: 1, maxAgeHours: 0 } } },
            stateKey,
            toStoredTargetKind: (targetKind) => targetKind,
            toSessionBindingTargetKind: (targetKind) => targetKind,
          });
        }
        const binding = await service.bind({
          conversation,
          targetSessionKey: "agent:target:main",
          targetKind: "session",
        });
        expect(observer.counts.run, "fixture binding writes are observable").toBeGreaterThan(0);
        observer.reset();
        const result = await resolveRuntimeConversationBindingRouteAsync({ route, conversation });
        expect(result.bindingRecord?.bindingId).toBe(binding.bindingId);
        expect(result.route.sessionKey).toBe(binding.targetSessionKey);
        expect(result.bindingOwnerAvailable).toBe(true);
        expect(observer.counts).toEqual(emptyCounts());
      } finally {
        observer.restore();
      }
      expect(service.resolveByConversation(conversation)?.metadata?.lastActivityAt).toEqual(
        expect.any(Number),
      );
    },
  );
});
