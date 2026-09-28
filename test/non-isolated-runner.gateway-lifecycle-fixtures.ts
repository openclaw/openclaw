import path from "node:path";

export function gatewayWorkerLifetimeFixtureFiles(repoRoot: string): Record<string, string> {
  const source = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  const imports = `import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { openOpenClawStateDatabase, closeOpenClawStateDatabase } from ${source("state/openclaw-state-db.ts")};
import { readCachedClawInstallSchemaVersions, registerClawInstallSchemaVersionSnapshotListener } from ${source("claws/provenance-runtime-read.ts")};
const root = process.env.GATEWAY_LIFETIME_PROBE_ROOT!;
const log = path.join(root, "events.log");
const lines = () => readFileSync(log, "utf8").trim().split("\\n");
`;
  return {
    "a-producer.test.ts": `${imports}
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
const options = { env: { OPENCLAW_STATE_DIR: path.join(root, "producer-state") } };
let database: ReturnType<typeof openOpenClawStateDatabase>;
registerClawInstallSchemaVersionSnapshotListener(() => {
  appendFileSync(log, "A:" + readCachedClawInstallSchemaVersions(options).kind + "\\n");
});
it("keeps live provenance notifications through afterAll", () => {
  database = openOpenClawStateDatabase(options);
  expect(database.db.isOpen).toBe(true);
  expect(lines()).toContain("A:ready");
});
afterAll(() => {
  expect(database.db.isOpen, "fixture must reach runner drain with an open database").toBe(true);
  expect(lines()).not.toContain("A:resource-drained");
  appendFileSync(log, "A:afterAll-open\\n");
});
`,
    "b-observer.test.ts": `${imports}
const options = { env: { OPENCLAW_STATE_DIR: path.join(root, "observer-state") } };
registerClawInstallSchemaVersionSnapshotListener(() => {
  appendFileSync(log, "B:" + readCachedClawInstallSchemaVersions(options).kind + "\\n");
});
it("drains the prior file and retires its provenance generation", () => {
  const prior = lines();
  const afterAll = prior.indexOf("A:afterAll-open");
  expect(afterAll).toBeGreaterThanOrEqual(0);
  expect(prior.slice(afterAll + 1), "prior database must close during runner drain").toContain("A:state-error");
  expect(prior.slice(afterAll + 1), "awaited runner resource drain must precede B").toContain("A:resource-drained");
  const before = prior.length;
  try {
    const database = openOpenClawStateDatabase(options);
    expect(database.db.isOpen).toBe(true);
    closeOpenClawStateDatabase();
    expect(database.db.isOpen).toBe(false);
    const observed = lines().slice(before);
    expect(observed).toContain("B:ready");
    expect(observed).toContain("B:state-error");
    expect(observed.filter((line) => line.startsWith("A:")), "retired provenance generation received a later file event").toEqual([]);
  } finally {
    closeOpenClawStateDatabase();
  }
});
`,
  };
}
