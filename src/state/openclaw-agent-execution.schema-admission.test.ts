import fs from "node:fs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { AgentDatabaseSchemaAdmissionInvalidError } from "./agent-database-admission-error.js";
import { invalidateOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { AgentDatabaseExecutionLifetime } from "./openclaw-agent-execution-authority.js";
import type { AgentDatabaseExecutionFileIdentity } from "./openclaw-agent-execution-contract.js";
import { createAgentDatabaseNativeGeneration as createNative } from "./openclaw-agent-execution-native.js";
import {
  createAgentCreationWitnessFixture,
  createAgentCreationWitnessSource as createSource,
} from "./openclaw-agent-execution.creation-fixture.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "./openclaw-agent-execution.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

function fixture() {
  const options = createAgentCreationWitnessFixture();
  const { env } = options;
  const { path } = openOpenClawAgentDatabase(options);
  const generation = (identity?: AgentDatabaseExecutionFileIdentity) => {
    const context = captureOpenClawStateWorkerContext({ env });
    const lifetime = new AgentDatabaseExecutionLifetime().state;
    const noop = () => {};
    const native = createNative("main", path, context, lifetime, noop, noop, identity, noop, noop);
    return Object.assign(native, { [Symbol.asyncDispose]: () => native.close() });
  };
  return { env, options, path, generation };
}

it.each([false, true])(
  "preserves clean restart proof on refused worker admission (prepared: %s)",
  async (prepared) => {
    const { env, path, generation: createGeneration } = fixture();
    closeOpenClawAgentDatabaseByPath(path);
    const seal = fs.readFileSync(`${path}.seal`, "utf8");
    const identity = readDatabasePathIdentitySync(path);
    await using generation = createGeneration(
      prepared
        ? {
            kind: "file",
            physicalIdentity: identity.key.slice("file:".length),
            birthtime: identity.birthtime,
            nativeLocation: identity.canonicalPath,
          }
        : undefined,
    );
    let refused = false;
    const refusalError = new Error("Synthetic shutdown refused late admission");
    const operation = vi.fn(async () => "forbidden");
    using refusal = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
      if (
        request.stage === "prepare" &&
        isRecord(request.facts) &&
        request.facts.kind === "agent-validation-start"
      ) {
        refused = true;
        throw refusalError;
      }
      admit(request, grant);
    });
    await expect(generation.run(createSource(), operation)).rejects.toBe(refusalError);
    await generation.close();
    refusal.mockRestore();
    expect(refused).toBe(true);
    expect(operation).not.toHaveBeenCalled();
    const state = openOpenClawStateDatabase({ env }).db;
    expect(state.prepare("SELECT lease_id FROM agent_database_leases").all()).toEqual([]);
    expect(fs.readFileSync(`${path}.seal`, "utf8")).toBe(seal);
    expect(readSqliteDatabaseCleanClose(path)).toBe(true);
  },
);

it("rejects malformed native schema receipts without replaying caller work", async () => {
  const { options, path } = fixture();
  closeOpenClawAgentDatabaseByPath(path);
  const execution = captureOpenClawAgentDatabaseExecution(options);
  let publications = 0;
  const malformed = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, admit) => {
    const facts = request.facts;
    if (
      request.stage === "prepare" &&
      isRecord(facts) &&
      isRecord(facts.identity) &&
      facts.identity.nativeLocation === path &&
      facts.validation !== undefined
    ) {
      publications += 1;
      request.facts = { ...facts, validation: {} };
    }
    admit(request, grant);
  });
  const source = { ...createSource(), assertCurrent: () => execution.assertCurrent() };
  const operation = vi.fn(async () => "not admitted");
  try {
    await expect(execution.runExisting(source, operation)).rejects.toBeInstanceOf(
      AgentDatabaseSchemaAdmissionInvalidError,
    );
    expect(publications).toBe(1);
    expect(operation).not.toHaveBeenCalled();
  } finally {
    malformed.mockRestore();
    await execution.release();
  }
});

it("admits schema and integrity once, then warm turns request only their writes", async () => {
  const { path, generation: createGeneration } = fixture();
  // Force cold verification; warm turns must reuse it (#166253).
  invalidateOpenClawAgentDatabaseValidation(path);
  await using generation = createGeneration();
  const requests: string[] = [];
  const source = createSource((request) => {
    const kind = isRecord(request.facts) ? request.facts.kind : undefined;
    requests.push(typeof kind === "string" ? `${request.stage}:${kind}` : request.stage);
  });
  const turn = (sessionId: string) =>
    generation.run(
      source,
      (scope) =>
        scope.execute({
          type: "session.transcript.initialize",
          input: { sessionKey: `agent:main:${sessionId}`, sessionId },
        }),
      undefined,
      true,
    );
  await turn("first-turn");
  expect(requests).toEqual(
    expect.arrayContaining(["open", "prepare:agent-validation-start", "commit"]),
  );
  requests.length = 0;
  await turn("second-turn");
  await turn("third-turn");
  const write = ["prepare", "transaction", "commit"];
  expect(requests).toEqual([...write, ...write]);
});
