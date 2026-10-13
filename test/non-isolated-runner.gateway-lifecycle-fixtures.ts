import path from "node:path";

export function gatewayWorkerLifetimeFixtureFiles(
  repoRoot: string,
  mode: "threads" | "provenance",
): Record<string, string> {
  const source = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  const provenance = mode === "provenance";
  const contract = provenance ? "provenance" : "database";
  const registerListener = provenance
    ? "registerClawInstallSchemaVersionSnapshotListener"
    : "registerOpenClawStateDatabaseLifecycleListener";
  const callback = provenance ? "()" : "(event)";
  const observation = provenance
    ? "readCachedClawInstallSchemaVersions(options).kind"
    : "event.kind";
  const prepare = provenance ? "(await prepareClawInstallSchemaVersions(options)).publish();" : "";
  const ready = provenance ? "ready" : "opened";
  const closed = provenance ? "state-error" : "closed";
  const imports = `import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { openOpenClawStateDatabase, closeOpenClawStateDatabase, registerOpenClawStateDatabaseLifecycleListener } from ${source("state/openclaw-state-db.ts")};
${provenance ? `import { prepareClawInstallSchemaVersions, readCachedClawInstallSchemaVersions, registerClawInstallSchemaVersionSnapshotListener } from ${source("claws/provenance-runtime-read.ts")};` : ""}
const root = process.env.GATEWAY_LIFETIME_PROBE_ROOT!;
const log = path.join(root, "${mode}-events.log");
const lines = () => readFileSync(log, "utf8").trim().split("\\n");
`;
  return {
    [`${mode}-a-producer.test.ts`]: `${imports}
import { resolveGlobalSingleton } from ${source("shared/global-singleton.ts")};
const cleanupKey = Symbol("gateway fixture resource drain");
resolveGlobalSingleton(cleanupKey, () => ({}), async () => {
  try {
    await Promise.resolve();
    appendFileSync(log, "A:resource-drained\\n");
  } finally {
    Reflect.get(globalThis, Symbol.for("openclaw.globalSingletonLifecycleResets")).delete(cleanupKey);
    Reflect.deleteProperty(globalThis, cleanupKey);
  }
});
const options = { env: { OPENCLAW_STATE_DIR: path.join(root, "${mode}-producer-state") } };
${registerListener}(${callback} => {
  appendFileSync(log, "A:" + ${observation} + "\\n");
});
const database = openOpenClawStateDatabase(options);
${prepare}
it("keeps live ${contract} notifications through afterAll", () => {
  expect(database.db.isOpen).toBe(true);
  expect(lines()).toContain("A:${ready}");
});
afterAll(() => {
  expect(database.db.isOpen, "fixture must reach runner drain with an open database").toBe(true);
  expect(lines()).not.toContain("A:resource-drained");
  appendFileSync(log, "A:afterAll-open\\n");
});
`,
    [`${mode}-b-observer.test.ts`]: `${imports}
const options = { env: { OPENCLAW_STATE_DIR: path.join(root, "${mode}-observer-state") } };
${registerListener}(${callback} => {
  appendFileSync(log, "B:" + ${observation} + "\\n");
});
const prior = lines();
const before = prior.length;
const database = openOpenClawStateDatabase(options);
${prepare}
it("drains the prior file and retires its ${contract} generation", () => {
  const afterAll = prior.indexOf("A:afterAll-open");
  expect(afterAll).toBeGreaterThanOrEqual(0);
  expect(prior.slice(afterAll + 1), "prior database must close during runner drain").toContain("A:${closed}");
  expect(prior.slice(afterAll + 1), "awaited runner resource drain must precede B").toContain("A:resource-drained");
  try {
    expect(database.db.isOpen).toBe(true);
    closeOpenClawStateDatabase();
    expect(database.db.isOpen).toBe(false);
    const observed = lines().slice(before);
    expect(observed).toContain("B:${ready}");
    expect(observed).toContain("B:${closed}");
    expect(observed.filter((line) => line.startsWith("A:")), "retired ${contract} generation received a later file event").toEqual([]);
  } finally {
    closeOpenClawStateDatabase();
  }
});
`,
  };
}
