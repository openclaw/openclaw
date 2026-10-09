import { expectTypeOf, it } from "vitest";

type SqliteRuntime = typeof import("./sqlite-runtime.js");
type PublicationSource = Parameters<SqliteRuntime["openOpenClawAgentSqliteWorkerStore"]>[1];
type Execution = Extract<PublicationSource, { execution: unknown }>["execution"];
type Source = Parameters<Execution["prepare"]>[0];
type ReleasedPrepare = (source: Source, signal?: AbortSignal) => Promise<void>;
// v2026.9.9 accepted this shape before host-only preparation and adoption capabilities.
type ReleasedExecution = {
  readonly agentId: string;
  readonly path: string;
  readonly fileIdentity: Execution["fileIdentity"];
  assertCurrent(): void;
  captureGenerationClaim: Execution["captureGenerationClaim"];
  prepare: ReleasedPrepare;
  runExisting: Execution["runExisting"];
  release(): Promise<void>;
};

it("retains released agent execution preparation calls and implementations", () => {
  expectTypeOf<{ execution: ReleasedExecution }>().toExtend<PublicationSource>();
  expectTypeOf<ReleasedPrepare>().toExtend<Execution["prepare"]>();
  expectTypeOf<Execution["prepare"]>().toExtend<ReleasedPrepare>();
  expectTypeOf<[Source]>().toExtend<Parameters<Execution["prepare"]>>();
  expectTypeOf<[Source, AbortSignal]>().toExtend<Parameters<Execution["prepare"]>>();
  expectTypeOf<ReturnType<Execution["prepare"]>>().toEqualTypeOf<Promise<void>>();
});
