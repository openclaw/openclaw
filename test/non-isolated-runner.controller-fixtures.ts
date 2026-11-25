import path from "node:path";

export function controllerStorageFixtureFiles(repoRoot: string): Record<string, string> {
  const source = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  return {
    "05-c-mailbox-storage.test.ts": `
import { expect, it, vi } from "vitest";
// mock-isolation: this fixture must fail if mailbox-only cleanup imports Stop.
vi.mock(${source("sessions/session-controller.stop.ts")}, () => { throw new Error("mailbox-only fixture loaded Stop"); });
const mailbox = await import(${source("sessions/session-controller.mailbox.ts")});
const key = "agent:main:runner-mailbox-only";
const owner = mailbox.getSessionControllerMailbox(key);
Reflect.set(globalThis, Symbol.for("fixture.controllerMailbox"), { mailbox, key });
it("allocates a real mailbox without loading the Stop owner", () => {
  expect(mailbox.getExistingSessionControllerMailbox(key)).toBe(owner);
  expect(Reflect.get(globalThis, Symbol.for("openclaw.sessionControllerTestApi"))?.drainSessionControllerOwnersForTest).toBeUndefined();
});
`,
    "05-d-mailbox-retirement.test.ts": `
import { expect, it } from "vitest";
it("retires the original mailbox-only storage before the next file", () => {
  const key = Symbol.for("fixture.controllerMailbox");
  const prior = Reflect.get(globalThis, key);
  try {
    expect(prior.mailbox.getExistingSessionControllerMailbox(prior.key)).toBeUndefined();
  } finally {
    Reflect.deleteProperty(globalThis, key);
  }
});
`,
    "05-e-controller-rpc-write.test.ts": `
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
vi.mock(${source("sessions/session-controller.stop.ts")}, async (importOriginal) => ({ ...await importOriginal() }));
const mailbox = await import(${source("sessions/session-controller.mailbox.ts")});
const rpc = await import(${source("sessions/session-controller.rpc-sources.ts")});
const writer = new DatabaseSync(path.join(import.meta.dirname, "controller-write.sqlite"));
writer.exec("CREATE TABLE completed (value TEXT NOT NULL)");
const adapter = { async onSettled() {
  await Promise.resolve();
  writer.prepare("INSERT INTO completed VALUES (?)").run("settled");
} };
const runId = "runner-rpc-write";
const input = mailbox.reserveSessionControllerSource("agent:main:runner-rpc-write", {
  protocolRunId: runId, policy: { mode: "followup" }, adapter,
});
rpc.registerRpcSource(runId, { input, adapter });
Reflect.set(globalThis, Symbol.for("fixture.controllerRpc"), { rpc, writer, runId, input });
it("retains a real indexed source whose settlement owns a SQLite write", () => {
  expect(rpc.getRpcSource(runId)?.input).toBe(input);
  expect(writer.prepare("SELECT value FROM completed").all()).toEqual([]);
});
afterAll(() => {
  expect(rpc.hasRpcSource(runId)).toBe(true);
  vi.resetModules();
});
`,
    "05-f-controller-rpc-settled.test.ts": `
import { expect, it } from "vitest";
it("joins the original partially mocked Stop and its real write after module reset", async () => {
  const key = Symbol.for("fixture.controllerRpc");
  const prior = Reflect.get(globalThis, key);
  try {
    await prior.input.settlement.promise;
    expect(prior.input.abortSignal.aborted).toBe(true);
    expect(prior.rpc.hasRpcSource(prior.runId)).toBe(false);
    expect(prior.writer.prepare("SELECT value FROM completed").all()).toEqual([{ value: "settled" }]);
  } finally {
    prior.writer.close();
    Reflect.deleteProperty(globalThis, key);
  }
});
`,
    "05-g-controller-mock-only.test.ts": `
import { expect, it, vi } from "vitest";
// mock-isolation: no real Stop exports or storage may execute in this mock-only case.
vi.mock(${source("sessions/session-controller.stop.ts")}, () => ({ fixture: "mock-only" }));
const stop = await import(${source("sessions/session-controller.stop.ts")});
it("does not evaluate storage behind a mock-only Stop import", () => {
  expect(stop.fixture).toBe("mock-only");
  expect(Object.hasOwn(globalThis, Symbol.for("openclaw.sessionControllerTestApi"))).toBe(false);
  expect(Reflect.get(globalThis, Symbol.for("openclaw.sessionControllers"))?.controllers.size ?? 0).toBe(0);
});
`,
    "05-h-controller-mock-retired.test.ts": `
import { expect, it } from "vitest";
it("keeps mock-only cleanup from allocating a controller or Stop publication", () => {
  expect(Object.hasOwn(globalThis, Symbol.for("openclaw.sessionControllerTestApi"))).toBe(false);
  expect(Reflect.get(globalThis, Symbol.for("openclaw.sessionControllers"))?.controllers.size ?? 0).toBe(0);
});
`,
    "96-a-controller-write-failure.test.ts": `
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { expect, it } from "vitest";
const mailbox = await import(${source("sessions/session-controller.mailbox.ts")});
const rpc = await import(${source("sessions/session-controller.rpc-sources.ts")});
const state = await import(${source("sessions/session-controller.state.ts")});
const databaseOwner = await import(${source("state/openclaw-state-db.ts")});
const database = databaseOwner.openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: path.join(import.meta.dirname, "controller-retained-state") } });
const location = path.join(import.meta.dirname, "controller-readonly.sqlite");
const setup = new DatabaseSync(location);
setup.exec("CREATE TABLE completed (value TEXT NOT NULL)");
setup.close();
const writer = new DatabaseSync(location, { readOnly: true });
const adapter = { async onSettled() {
  await Promise.resolve();
  writer.prepare("INSERT INTO completed VALUES (?)").run("cannot-commit");
} };
const runId = "runner-rpc-write-failure";
const sessionKey = "agent:main:runner-rpc-write-failure";
const input = mailbox.reserveSessionControllerSource(sessionKey, {
  protocolRunId: runId, policy: { mode: "followup" }, adapter,
});
rpc.registerRpcSource(runId, { input, adapter });
const retainedKey = "agent:main:runner-failed-write-retained";
const retainedMailbox = mailbox.getSessionControllerMailbox(retainedKey);
Reflect.set(globalThis, Symbol.for("fixture.controllerWriteFailure"), { state, databaseOwner, database, writer, retainedKey, retainedMailbox, input });
it("admits a real source before its SQLite terminal write fails", () => {
  expect(rpc.getRpcSource(runId)?.input).toBe(input);
  expect(database.db.isOpen).toBe(true);
});
`,
    "96-b-controller-write-custody.test.ts": `
import { expect, it } from "vitest";
it("retains the original controller module and SQLite custody after a real write failure", async () => {
  const key = Symbol.for("fixture.controllerWriteFailure");
  const prior = Reflect.get(globalThis, key);
  const state = await import(${source("sessions/session-controller.state.ts")});
  try {
    await expect(prior.input.settlement.promise).rejects.toThrow(/readonly/u);
    expect(state).toBe(prior.state);
    // Failed sources retire normally; unrelated original storage must survive the failed file drain.
    expect(state.findSessionControllerEntry(prior.retainedKey)).toBe(prior.retainedMailbox.owner);
    expect(prior.database.db.isOpen).toBe(true);
    expect(Reflect.get(globalThis, Symbol.for("openclaw.sqliteTestRetainedCustody"))?.sqlite).toBe(true);
  } finally {
    prior.writer.close();
    await prior.databaseOwner.closeOpenClawStateDatabaseAsync();
    Reflect.deleteProperty(globalThis, key);
  }
});
`,
  };
}
