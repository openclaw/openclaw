import { readFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { DatabaseSync } from "node:sqlite";

// Test-only transport routing; provider responses and auth-state mutation remain real.
const options = new URL(import.meta.url).searchParams;
const fixture = new URL(options.get("fixture"));
const clockFile = options.get("clock");
if (options.has("catalog")) {
  const workers = createRequire(import.meta.url)("node:worker_threads");
  const Worker = workers.Worker;
  // Production workers intentionally clear execArgv. Carry this fixture's
  // network boundary into the real worker without replacing its catalog logic.
  workers.Worker = class extends Worker {
    constructor(url, workerOptions) {
      super(url, {
        ...workerOptions,
        execArgv: [...(workerOptions?.execArgv ?? process.execArgv), "--import", import.meta.url],
      });
    }
  };
  syncBuiltinESMExports();
}
const storageFaultFile = options.get("storageFault");
if (storageFaultFile) {
  // CLI respawns reset inherited signal handling; let SQLite receive EFBIG.
  process.on("SIGXFSZ", () => undefined);
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (!/^insert into "config_machine_state"/i.test(sql)) {
      return statement;
    }
    const run = statement.run.bind(statement);
    statement.run = (...args) => {
      this.exec("DROP TRIGGER IF EXISTS temp.quota_reset_write_fault");
      const fault = JSON.parse(readFileSync(storageFaultFile, "utf8"));
      if (fault) {
        const profile = '$.usageStats."openai:quota"';
        const condition =
          fault.write === "claim"
            ? `json_extract(NEW.value_json, '${profile}.lastProbeAt')
                 IS NOT json_extract(OLD.value_json, '${profile}.lastProbeAt')
               AND json_extract(NEW.value_json, '${profile}.blockedUntil') IS NOT NULL`
            : `json_extract(NEW.value_json, '${profile}.blockedUntil') IS NULL`;
        const action =
          fault.failure === "constraint"
            ? "SELECT RAISE(ABORT, 'quota test constraint invariant');"
            : `INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
               VALUES ('quota-reset-test.scratch', json_quote(hex(zeroblob(96 * 1024 * 1024))), 0);`;
        // TEMP keeps the production schema intact. The oversized write reaches
        // the Gateway's real file-size limit; no I/O exception is fabricated.
        this.exec(`
          CREATE TEMP TRIGGER quota_reset_write_fault
          BEFORE UPDATE ON main.config_machine_state
          WHEN NEW.state_key = 'authProfiles.state'
            AND json_extract(OLD.value_json, '${profile}.blockedUntil') IS NOT NULL
            AND ${condition}
          BEGIN ${action} END;
        `);
      }
      try {
        return run(...args);
      } catch (error) {
        console.error("Quota fixture native storage error", {
          fault,
          code: error.code,
          errcode: error.errcode,
          message: error.message,
        });
        throw error;
      }
    };
    return statement;
  };
}
if (fixture.protocol !== "http:" || fixture.hostname !== "127.0.0.1" || !clockFile) {
  throw new Error("Quota fixture requires a loopback HTTP origin and a clock file");
}

const realNow = Date.now.bind(Date);
Date.now = () => {
  const offset = Number(readFileSync(clockFile, "utf8"));
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error("Quota clock offset must be a nonnegative integer");
  }
  return realNow() + offset;
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const route =
    options.has("catalog") && url.startsWith("https://chatgpt.com/backend-api/codex/models?")
      ? "/catalog/models"
      : url === "https://chatgpt.com/backend-api/wham/usage"
        ? "/core-wham/usage"
        : url === "https://chatgpt.com/backend-api/codex/responses"
          ? "/direct/responses"
          : url === "https://auth.openai.com/oauth/token"
            ? "/oauth/token"
            : undefined;
  if (!route) {
    return originalFetch(input, init);
  }
  const target = new URL(route, fixture);
  const fixtureInit = { ...init };
  delete fixtureInit.dispatcher;
  return originalFetch(input instanceof Request ? new Request(target, input) : target, fixtureInit);
};
// The existing hermetic transport contract also routes guarded OAuth refresh.
globalThis.fetch.mock = {};
