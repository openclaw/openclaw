import { expect, it } from "vitest";
import { FailoverError } from "../agents/failover/error.js";
import { CliBackendTransportError } from "../plugins/cli-backend-errors.js";
import {
  readSupervisedRuntimeDiagnostic,
  supervisedRuntimeFailureDiagnostic,
} from "./supervised-runtime-diagnostic.js";

it("preserves typed cause while dropping arbitrary provider fields at the control pipe", () => {
  const failure = new FailoverError("SYNTHETIC_PRIVATE_MESSAGE", {
    reason: "timeout",
    rawError: "SYNTHETIC_PRIVATE_RAW",
    profileId: "SYNTHETIC_PRIVATE_PROFILE",
  });
  const line = supervisedRuntimeFailureDiagnostic(new Error("wrapper", { cause: failure }));
  expect(line).toBe("supervised-runtime:failover:timeout");
  expect(readSupervisedRuntimeDiagnostic(`untrusted prose\n${line}\n`)).toBe(line);
});

it("refuses arbitrary serialized reasons and codes even when they resemble error contracts", () => {
  const error = {
    name: "FailoverError",
    reason: "SYNTHETIC_PRIVATE_REASON",
    code: "SYNTHETIC_PRIVATE_CODE",
  };
  expect(supervisedRuntimeFailureDiagnostic(error)).toBe("supervised-runtime:unknown:unclassified");
  expect(
    readSupervisedRuntimeDiagnostic("supervised-runtime:failover:SYNTHETIC_PRIVATE_REASON"),
  ).toBeUndefined();
  expect(
    readSupervisedRuntimeDiagnostic("prefix supervised-runtime:failover:auth suffix"),
  ).toBeUndefined();
});

it("bounds cause traversal, ignores accessors, and recognizes only selected OS failures", () => {
  const cycle: { cause?: unknown; code?: string } = {};
  cycle.cause = cycle;
  expect(supervisedRuntimeFailureDiagnostic(cycle)).toBe("supervised-runtime:unknown:unclassified");
  const guarded = Object.defineProperty({}, "cause", {
    get() {
      throw new Error("private");
    },
  });
  expect(supervisedRuntimeFailureDiagnostic(guarded)).toBe(
    "supervised-runtime:unknown:unclassified",
  );
  expect(
    supervisedRuntimeFailureDiagnostic(Object.assign(new Error("private path"), { code: "EROFS" })),
  ).toBe("supervised-runtime:os:EROFS");
});

it.each([
  { exitCode: -1, signal: null, expected: "exit:other" },
  { exitCode: 256, signal: null, expected: "exit:other" },
  { exitCode: Number.NaN, signal: null, expected: "exit:other" },
  { exitCode: 1.5, signal: null, expected: "exit:other" },
  { exitCode: null, signal: "SYNTHETIC_PRIVATE_SIGNAL", expected: "signal:other" },
])("bounds typed native metadata: $expected", ({ exitCode, signal, expected }) => {
  const error = new CliBackendTransportError("SYNTHETIC_PRIVATE_MESSAGE", {
    kind: "exit",
    exitCode,
    signal: null,
  });
  Object.assign(error.diagnostic, { signal });
  const line = supervisedRuntimeFailureDiagnostic(error);
  expect(line).toBe(`supervised-runtime:cli:${expected}`);
  expect(readSupervisedRuntimeDiagnostic(line)).toBe(line);
});

it("ignores typed metadata accessors and refuses forged or unbounded wire diagnostics", () => {
  let reads = 0;
  const error = new CliBackendTransportError("private", {
    kind: "exit",
    exitCode: 1,
    signal: null,
  });
  Object.defineProperty(error, "diagnostic", {
    get() {
      reads++;
      return { kind: "protocol" };
    },
  });
  expect(supervisedRuntimeFailureDiagnostic(error)).toBe("supervised-runtime:unknown:unclassified");
  expect(reads).toBe(0);
  expect(supervisedRuntimeFailureDiagnostic({ diagnostic: { kind: "protocol" } })).toBe(
    "supervised-runtime:unknown:unclassified",
  );
  for (const line of [
    "supervised-runtime:cli:exit:256",
    "supervised-runtime:cli:exit:-1",
    "supervised-runtime:cli:signal:SYNTHETIC_PRIVATE_SIGNAL",
    "prefix supervised-runtime:cli:protocol",
    "supervised-runtime:cli:protocol private",
  ]) {
    expect(readSupervisedRuntimeDiagnostic(line)).toBeUndefined();
  }
});

it("preserves native exit facts from a separately loaded SDK error constructor", () => {
  class ForeignSdkTransportError extends Error {
    readonly cliBackendTransportError = "v1";
    readonly diagnostic = { kind: "exit", exitCode: 23, signal: null };
  }
  const error = new ForeignSdkTransportError("SYNTHETIC_PRIVATE_MESSAGE");
  expect(supervisedRuntimeFailureDiagnostic(new Error("wrapper", { cause: error }))).toBe(
    "supervised-runtime:cli:exit:23",
  );
});

it("does not invoke a transport brand accessor", () => {
  let reads = 0;
  const error = Object.defineProperty(
    { diagnostic: { kind: "initialize" } },
    "cliBackendTransportError",
    {
      get() {
        reads++;
        return "v1";
      },
    },
  );
  expect(supervisedRuntimeFailureDiagnostic(error)).toBe("supervised-runtime:unknown:unclassified");
  expect(reads).toBe(0);
});

it.each([
  {
    received: true,
    complete: true,
    crashBanner: true,
    outOfMemoryBanner: true,
    expected: "oom_and_crash_banners",
  },
  {
    received: true,
    complete: false,
    crashBanner: false,
    outOfMemoryBanner: true,
    expected: "oom_banner",
  },
  {
    received: true,
    complete: true,
    crashBanner: true,
    outOfMemoryBanner: false,
    expected: "crash_banner",
  },
  {
    received: false,
    complete: false,
    crashBanner: false,
    outOfMemoryBanner: false,
    expected: "stderr_incomplete",
  },
  {
    received: false,
    complete: true,
    crashBanner: false,
    outOfMemoryBanner: false,
    expected: "stderr_absent",
  },
  {
    received: true,
    complete: true,
    crashBanner: false,
    outOfMemoryBanner: false,
    expected: "no_known_banner",
  },
])(
  "retains only closed process-wide ABRT observations: $expected",
  ({ expected, ...observation }) => {
    const error = new CliBackendTransportError("SYNTHETIC_PRIVATE_MESSAGE", {
      kind: "exit",
      exitCode: null,
      signal: "SIGABRT",
    }).withProcessStderr(observation);
    const line = supervisedRuntimeFailureDiagnostic(new Error("wrapper", { cause: error }));
    expect(line).toBe(`supervised-runtime:cli:signal:SIGABRT:${expected}`);
    expect(readSupervisedRuntimeDiagnostic(line)).toBe(line);
    expect(readSupervisedRuntimeDiagnostic(`${line}:SYNTHETIC_PRIVATE_DETAIL`)).toBeUndefined();
  },
);

it("does not execute stderr observation accessors or accept malformed flags", () => {
  let reads = 0;
  const processStderr = Object.defineProperty(
    {
      received: true,
      complete: true,
      crashBanner: false,
    },
    "outOfMemoryBanner",
    {
      get() {
        reads++;
        return true;
      },
    },
  );
  const error = new CliBackendTransportError("private", {
    kind: "exit",
    exitCode: null,
    signal: "SIGABRT",
  });
  Object.assign(error.diagnostic, { processStderr });
  expect(supervisedRuntimeFailureDiagnostic(error)).toBe("supervised-runtime:cli:signal:SIGABRT");
  expect(reads).toBe(0);
  for (const malformed of [
    { received: false, complete: true, crashBanner: true, outOfMemoryBanner: false },
    { received: true, complete: true, crashBanner: false, outOfMemoryBanner: "SYNTHETIC_PRIVATE" },
  ]) {
    Object.assign(error.diagnostic, { processStderr: malformed });
    expect(supervisedRuntimeFailureDiagnostic(error)).toBe("supervised-runtime:cli:signal:SIGABRT");
  }
});
