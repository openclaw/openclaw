import { expect, it, vi } from "vitest";
import { retainSqliteWriteAdmissionService } from "../sqlite-write-admission.js";
import { usePostgresFixture } from "./fixture.test-support.js";
import { decodePostgresError, POSTGRES_REQUEST_TIMEOUT_MS } from "./protocol.js";

const harness = usePostgresFixture();

function fixture(
  options: { lock?: number; statement?: number; transaction?: number } = {},
  lockError = decodePostgresError({ name: "error", message: "lock timeout", code: "55P03" }),
) {
  const db = harness.connection();
  const path = "/synthetic/postgres-admission.sqlite";
  vi.spyOn(db.anchor, "location").mockReturnValue(path);
  let now = 0;
  let attempts = 0;
  let busy = true;
  let nativeFailure: Error | undefined;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const settings = db.anchor.prepare("SELECT 1");
  vi.spyOn(settings, "all").mockReturnValue([
    { name: "lock_timeout", setting: String(options.lock ?? 1000) },
    { name: "statement_timeout", setting: String(options.statement ?? 2000) },
    ...(options.transaction === undefined
      ? []
      : [{ name: "transaction_timeout", setting: String(options.transaction) }]),
  ]);
  const prepare = vi.spyOn(db, "prepare").mockReturnValue(settings);
  const exec = vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql.startsWith("BEGIN")) {
      db.isTransaction = true;
    }
    if (sql === "ROLLBACK" || sql === "COMMIT") {
      db.isTransaction = false;
    }
    if (sql.includes("pg_advisory_xact_lock")) {
      attempts++;
      if (nativeFailure) {
        throw nativeFailure;
      }
      if (busy) {
        now++;
        throw lockError;
      }
    }
  });
  const service = vi.fn(() => {
    expect(db.isTransaction).toBe(false);
    busy = false;
  });
  harness.cleanups.push(retainSqliteWriteAdmissionService([path], service));
  return {
    db,
    prepare,
    exec,
    service,
    lockError,
    attempts: () => attempts,
    elapse: (ms: number) => {
      now += ms;
    },
    reject: (error: Error) => {
      nativeFailure = error;
    },
  };
}

it.each(["raw", "wrapped"])("services the holder before one body call for %s SQLSTATE", (shape) => {
  const native = Object.assign(new Error("lock timeout"), { code: "55P03" });
  const lockError =
    shape === "wrapped"
      ? Object.assign(new Error("lock timeout", { cause: native }), {
          code: "ERR_SQLITE_ERROR",
          errcode: 5,
        })
      : native;
  const f = fixture({ transaction: 2000 }, lockError);
  const body = vi.fn(() => {
    expect(f.db.isTransaction).toBe(true);
    expect(f.service).toHaveBeenCalledTimes(1);
    expect(f.exec).toHaveBeenLastCalledWith("SET LOCAL lock_timeout = '1000ms'");
  });
  f.db.runTransaction(body);
  expect(body).toHaveBeenCalledTimes(1);
  expect(f.attempts()).toBe(2);
  expect(f.db.isTransaction).toBe(false);
  expect(f.exec.mock.calls.map(([sql]) => sql)).toContain(
    "SET LOCAL transaction_timeout = 0; SET LOCAL transaction_timeout = '1999ms'; SET LOCAL transaction_timeout = '2000ms'",
  );
});

it.each(["callback", "closed", "transaction"] as const)(
  "refuses a %s service result without another acquisition",
  (mode) => {
    const f = fixture();
    f.service.mockImplementation(() => {
      if (mode === "callback") {
        throw new Error("service refusal");
      }
      if (mode === "closed") {
        f.db.isOpen = false;
      }
      if (mode === "transaction") {
        f.db.isTransaction = true;
      }
    });
    const body = vi.fn();
    expect(() => f.db.runTransaction(body)).toThrow(
      mode === "callback" ? "service refusal" : "open idle",
    );
    expect(f.attempts()).toBe(1);
    expect(body).not.toHaveBeenCalled();
  },
);

it.each(["40P01", "40001", "57014", "08006"])("does not retry decoded %s", (code) => {
  const f = fixture();
  const failure = decodePostgresError({ name: "error", message: "native refusal", code });
  f.reject(failure);
  const body = vi.fn();
  expect(() => f.db.runTransaction(body)).toThrow(failure);
  expect(f.attempts()).toBe(1);
  expect(f.service).not.toHaveBeenCalled();
  expect(body).not.toHaveBeenCalled();
});

it("never services or retries a failed rollback", () => {
  const f = fixture();
  const failure = new Error("rollback failed");
  const native = f.exec.getMockImplementation()!;
  f.exec.mockImplementation((sql) => {
    if (sql === "ROLLBACK") {
      throw failure;
    }
    native(sql);
  });
  vi.spyOn(f.db, "close").mockImplementation(() => {
    f.db.isOpen = false;
  });
  expect(() => f.db.runTransaction(vi.fn())).toThrow(failure);
  expect(f.attempts()).toBe(1);
  expect(f.service).not.toHaveBeenCalled();
  expect(f.db.isOpen).toBe(false);
});

it.each([
  { lock: 10, statement: 0, transaction: 0, elapsed: 10, code: "55P03" },
  { lock: 0, statement: 10, transaction: 0, elapsed: 10, code: "57014" },
  { lock: 0, statement: 0, transaction: 10, elapsed: 10, code: "25P04" },
  { lock: 0, statement: 0, transaction: 0, elapsed: POSTGRES_REQUEST_TIMEOUT_MS, code: undefined },
])("keeps the whole acquisition budget $code with zero timeout semantics", (options) => {
  const f = fixture(options);
  f.service.mockImplementation(() => f.elapse(options.elapsed));
  vi.spyOn(f.db, "close").mockImplementation(() => {
    f.db.isOpen = false;
  });
  const body = vi.fn();
  let failure: unknown;
  try {
    f.db.runTransaction(body);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  if (options.code && options.code !== "55P03") {
    expect(failure).toMatchObject({ code: options.code });
  } else if (!options.code) {
    expect(failure).toMatchObject({ message: expect.stringContaining("bridge request deadline") });
  }
  if (options.code === "55P03") {
    expect(failure).toBe(f.lockError);
  }
  if (options.code === "57014") {
    expect(failure).toMatchObject({ name: "PostgresQueryCanceledError" });
  }
  expect(f.db.isOpen).toBe(options.code !== "25P04");
  expect(f.attempts()).toBe(1);
  expect(body).not.toHaveBeenCalled();
});

it.each(["readOnly", "nested", "reserved"] as const)(
  "keeps %s transaction ownership unchanged",
  (mode) => {
    const f = fixture();
    f.db.isTransaction = mode !== "readOnly";
    const body = vi.fn();
    f.db.runTransaction(body, undefined, mode === "readOnly", mode === "reserved");
    expect(body).toHaveBeenCalledOnce();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.service).not.toHaveBeenCalled();
    expect(f.attempts()).toBe(0);
  },
);

it.each(["begin", "lock", "restore"] as const)(
  "refuses a late %s reply before entering the body",
  (phase) => {
    const f = fixture({ lock: 100, statement: 0 });
    const native = f.exec.getMockImplementation()!;
    f.exec.mockImplementation((sql) => {
      native(sql);
      if (
        (phase === "begin" && sql.startsWith("BEGIN")) ||
        (phase === "lock" && sql.includes("pg_advisory_xact_lock")) ||
        (phase === "restore" && sql === "SET LOCAL lock_timeout = '100ms'")
      ) {
        f.elapse(100);
      }
    });
    const body = vi.fn();
    expect(() => f.db.runTransaction(body)).toThrow();
    expect(body).not.toHaveBeenCalled();
    expect(f.db.isTransaction).toBe(false);
    expect(f.exec.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  },
);
