import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import * as nodeSqlite from "./node-sqlite.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationAnchor,
} from "./package-update-activation-journal.js";
import {
  createPublicationTestFixture,
  runPublicationSwap,
  withPublicationFence,
} from "./package-update-publication.test-support.js";

// Explicit benchmark workload: fresh private package/state, real publication and
// retirement owners. The fixture supplies an inert recovery runtime, not a CLI update.
const fixture = createPublicationTestFixture();
it.skipIf(process.platform === "win32" || process.env.OPENCLAW_BENCH_RETIREMENT !== "1")(
  "measures verified retirement of a 2000-file previous package",
  fixture.withFixture(async (f) => {
    for (let directory = 0; directory < 40; directory++) {
      const root = path.join(f.packageRoot, `payload-${directory}`);
      fs.mkdirSync(root);
      for (let file = 0; file < 50; file++) {
        fs.writeFileSync(path.join(root, `${file}.txt`), "synthetic package payload\n");
      }
    }
    await withPublicationFence(f.packageRoot, async (fence) => {
      const { result, transaction } = await runPublicationSwap(f, fence);
      expect(result.status, result.step.stderrTail ?? "").toBe("committed");
      expect(transaction).toBeDefined();
      const anchor = resolvePackageActivationAnchor(f.packageRoot);
      const candidate = fs.readFileSync(path.join(f.packageRoot, "package.json"));
      const record = openPackageActivationJournal(anchor).read();
      expect(record.phase).toBe("publication-complete");

      const counters = {
        journalOpens: 0,
        journalCloses: 0,
        journalPrepares: 0,
        journalReads: 0,
        allOpens: 0,
      };
      const journals = new Set<DatabaseSync>();
      const open = nodeSqlite.openNodeSqliteDatabase;
      const observedQueries = new Map<string, number>();
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
        const db = open(...args);
        counters.allOpens++;
        if (args[0].includes("operation.sqlite")) {
          counters.journalOpens++;
          journals.add(db);
          const prepare = db.prepare.bind(db);
          const close = db.close.bind(db);
          db.prepare = (sql) => {
            counters.journalPrepares++;
            const statement = prepare(sql);
            // Observe execution as well as preparation: cached statements still
            // have to read the current intent on every mutation boundary.
            statement.all = new Proxy(statement.all.bind(statement), {
              apply(target, receiver, parameters) {
                observedQueries.set(sql, (observedQueries.get(sql) ?? 0) + 1);
                if (sql.startsWith('select * from "package_activation"') && parameters[0] === 2) {
                  counters.journalReads++;
                }
                return Reflect.apply(target, receiver, parameters);
              },
            });
            return statement;
          };
          db.close = () => {
            if (db.isOpen) {
              counters.journalCloses++;
            }
            close();
          };
        }
        return db;
      });
      const profiler = process.env.OPENCLAW_RETIREMENT_PROFILE ? new Session() : undefined;
      if (profiler) {
        profiler.connect();
        await profiler.post("Profiler.enable");
        await profiler.post("Profiler.start");
      }
      const beforeMemory = process.memoryUsage();
      const loadBefore = os.loadavg();
      const cpu = process.cpuUsage();
      const start = performance.now();
      const outcome = await transaction!.complete(
        { activationVerified: true },
        fence.assertCurrent,
      );
      const wallMs = performance.now() - start;
      const usedCpu = process.cpuUsage(cpu);
      const afterMemory = process.memoryUsage();
      if (profiler) {
        const { profile } = await profiler.post("Profiler.stop");
        profiler.disconnect();
        fs.writeFileSync(process.env.OPENCLAW_RETIREMENT_PROFILE!, JSON.stringify(profile));
      }
      const measurements = {
        workload: { files: 2000, directories: 40 },
        node: process.version,
        platform: process.platform,
        timestamp: new Date().toISOString(),
        wallMs,
        cpuMs: (usedCpu.user + usedCpu.system) / 1000,
        beforeMemory,
        afterMemory,
        loadBefore,
        loadAfter: os.loadavg(),
        counters: { ...counters },
        queries: Object.fromEntries(observedQueries),
        outcome,
      };
      expect(outcome).toBeUndefined();
      expect(fs.existsSync(anchor)).toBe(false);
      expect(fs.readFileSync(path.join(f.packageRoot, "package.json"))).toEqual(candidate);
      expect([...journals].every((db) => !db.isOpen)).toBe(true);
      expect(counters.journalOpens).toBe(counters.journalCloses);
      console.log(`RETIREMENT_MEASUREMENT ${JSON.stringify(measurements)}`);
    });
  }),
);
