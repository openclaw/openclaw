import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  classifyWorkerRequest,
  normalizeWorkerRequestClass,
} from "../src/infra/sqlite-worker-request-class.js";

type DomainCommands<Backend extends { execute: (...args: never[]) => unknown }> = Record<
  Parameters<Backend["execute"]>[0] extends { type: infer Type extends string } ? Type : never,
  true
>;

// Exhaustive against each backend contract: new commands must enter the diagnostic census.
const domains = {
  "extensions/memory-core/src/memory-entry-origins.worker.ts": {
    delete: true,
    "forget.mark": true,
    "forget.purge": true,
    prune: true,
    record: true,
    reserve: true,
  } satisfies DomainCommands<
    ReturnType<typeof import("../extensions/memory-core/test-api.js").bindMemoryEntryOriginsBackend>
  >,
  "extensions/memory-core/src/memory/manager-publication.worker.ts": {
    "cache.clear": true,
    "cache.prune": true,
    "cache.read": true,
    "cache.retire": true,
    "cache.stage.start": true,
    "cache.write": true,
    "cache.write.inline": true,
    "connection.inspect": true,
    "database.publish": true,
    "database.reset": true,
    "database.stage.discard": true,
    "database.stage.publish": true,
    "database.stage.start": true,
    "index.facts": true,
    "index.upgradeProviderKey": true,
    "index.writeMetadata": true,
    "schema.admit": true,
    "source.chunks": true,
    "source.delete": true,
    "source.hash": true,
    "source.refresh": true,
    "source.replace": true,
    "source.replace.group": true,
    "source.replace.inline": true,
    "source.state": true,
    "stage.append": true,
    "stage.discard": true,
    "stage.start": true,
    "vector.ensure": true,
    "vector.prepare": true,
  } satisfies DomainCommands<
    ReturnType<typeof import("../extensions/memory-core/test-api.js").bindMemoryPublicationBackend>
  >,
  "extensions/memory-core/src/standing-intents.worker.ts": {
    cancel: true,
    create: true,
    list: true,
    match: true,
    sweep: true,
  } satisfies DomainCommands<
    ReturnType<typeof import("../extensions/memory-core/test-api.js").bindStandingIntentsBackend>
  >,
  "src/agents/auth-profiles/inline-usage.worker.ts": {
    "authProfiles.enrollAuthorization": true,
    "authProfiles.inlineFailure": true,
    "authProfiles.inlineSnapshot": true,
    "authProfiles.update": true,
    "authProfiles.usage": true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/agents/auth-profiles/inline-usage.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/agents/harness/context-engine-turn-outbox.worker.ts": {
    acceptIntent: true,
    complete: true,
    discardIntent: true,
    enqueueIntent: true,
    hasPending: true,
    listPendingSessions: true,
    prepareRun: true,
    publishClosedTurn: true,
    readNextPending: true,
    recordFailure: true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/agents/harness/context-engine-turn-outbox.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/agents/plugin-model-catalog.worker.ts": {
    "catalog.pruneRemovedProviders": true,
    "catalog.removeCredentials": true,
    "catalog.replace": true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/agents/plugin-model-catalog.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/agents/sessions/session-manager-metadata.worker.ts": {
    "session.metadata.append": true,
    "session.metadata.initialize": true,
    "session.metadata.mutation": true,
    "session.transcript.appendMessage": true,
    "session.transcript.branch": true,
    "session.transcript.compactionBoundary": true,
    "session.transcript.replaceSuffix": true,
    "session.transcript.rewrite": true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/agents/sessions/session-manager-metadata.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/boards/sqlite-board-store.worker.ts": {
    "boards.applyOps": true,
    "boards.grant": true,
    "boards.putWidget": true,
  } satisfies DomainCommands<
    ReturnType<typeof import("../src/boards/sqlite-board-store.worker.js").bindSqliteWorkerBackend>
  >,
  "src/config/sessions/goals-operations.worker.ts": {
    "session.goal.mutate": true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/config/sessions/goals-operations.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/config/sessions/session-accessor.sqlite-transcript-reports.worker.ts": {
    abortedPartial: true,
    append: true,
    assistant: true,
    prepare: true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/config/sessions/session-accessor.sqlite-transcript-reports.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/config/sessions/session-fork-domain.worker.ts": {
    "session.messageCut.fork": true,
    "session.parentFork.commit": true,
    "session.parentFork.prepare": true,
    "session.parentFork.source": true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/config/sessions/session-fork-domain.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/config/sessions/session-lifecycle-projection.worker.ts": {
    finish: true,
    prepare: true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/config/sessions/session-lifecycle-projection.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/config/sessions/session-message-rewrite.worker.ts": {
    "session.messageRewrite.commit": true,
    "session.messageRewrite.modelPrompt": true,
    "session.messageRewrite.prepare": true,
    "session.transcript.correct": true,
    "session.transcript.event.append": true,
    "session.transcript.lock.cold": true,
    "session.transcript.lock.commit": true,
    "session.transcript.lock.facts": true,
    "session.transcript.lock.prepare": true,
    "session.transcript.lock.read": true,
    "session.transcript.manualCompact": true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/config/sessions/session-message-rewrite.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/config/sessions/session-sharing-store.worker.ts": {
    add: true,
    "category.apply": true,
    "category.prepare": true,
    involvement: true,
    "owner.assign": true,
    participant: true,
    remove: true,
    "suggestion.add": true,
    "suggestion.claim": true,
    "suggestion.finalize": true,
    "suggestion.release": true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/config/sessions/session-sharing-store.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/config/sessions/session-transcript-active-facts-backfill.worker.ts": {
    batch: true,
    discover: true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/config/sessions/session-transcript-active-facts-backfill.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/config/sessions/session-transcript-projection-publication.worker.ts": {
    appendChunk: true,
    claim: true,
    deleteChunk: true,
    finalize: true,
    preflight: true,
    sweep: true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/config/sessions/session-transcript-projection-publication.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/gateway/worker-environments/transcript-commit.worker.ts": {
    "transcript.commit": true,
    "transcript.prepare": true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/gateway/worker-environments/transcript-commit.worker.js").bindSqliteWorkerBackend
    >
  >,
  "src/session-cards/progress-card-store.worker.ts": {
    put: true,
  } satisfies DomainCommands<
    ReturnType<
      typeof import("../src/session-cards/progress-card-store.worker.js").bindSqliteWorkerBackend
    >
  >,
};

it("classifies every built-in domain command within the closed metric vocabulary", () => {
  for (const [modulePath, commands] of Object.entries(domains)) {
    for (const type of Object.keys(commands)) {
      for (const mode of ["execute", "publish"]) {
        const label = classifyWorkerRequest(`database.domain.${mode}`, {
          moduleUrl: `file:///synthetic/${modulePath}`,
          command: { type },
        });
        expect(label, `${modulePath}: ${mode} ${type}`).not.toBe("domain_execute");
        expect(normalizeWorkerRequestClass(label)).toBe(label);
      }
    }
  }
});

it("includes every built-in connection-bound backend in the command census", () => {
  const backends = [
    ...globSync(["src/**/*.worker.ts", "extensions/**/*.worker.ts"], {
      cwd: resolve(import.meta.dirname, ".."),
      exclude: ["**/node_modules/**"],
    }),
  ].filter((file) =>
    /export\s+(?:async\s+)?(?:function|const)\s+bindSqliteWorkerBackend\b/.test(
      readFileSync(resolve(import.meta.dirname, "..", file), "utf8"),
    ),
  );
  expect(backends.map((file) => file.replaceAll("\\", "/")).toSorted()).toEqual(
    Object.keys(domains).toSorted(),
  );
});
