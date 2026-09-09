import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, vi } from "vitest";
import { inspectAuthProfileJsonCellReadOnly } from "../../agents/auth-profiles/sqlite.js";
import * as sqlite from "../../infra/node-sqlite.js";

export function candidateCustodyProbe(agent: boolean): string {
  return `
    import { DatabaseSync } from 'node:sqlite';
    import path from 'node:path';
    if (process.argv.includes('--check')) {
      console.log(JSON.stringify({executorDelegation:'pid-start-v1',candidateMutation:'checkpoint-owned-v1'}));
    } else {
      let raw='';for await (const chunk of process.stdin) raw+=chunk;
      const input=JSON.parse(raw);const state=input.params.opts.run.env.OPENCLAW_STATE_DIR;
      const files=[path.join(state,'state/openclaw.sqlite')];
      if (${JSON.stringify(agent)}) files.push(path.join(state,'agents/main/agent/openclaw-agent.sqlite'));
      const observations=[];
      for(const file of files) {
        const db=new DatabaseSync(file);
        try {
          db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; ROLLBACK;');
          observations.push({file,exclusive:true});
        } catch(error) {observations.push({file,exclusive:false,error:String(error)});}
        finally {db.close();}
      }
      console.log(JSON.stringify(observations));
      // This measures physical custody, never fabricates a candidate completion.
      process.exitCode=37;
    }
  `;
}

export async function holdForeignAgentReader(file: string) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1],{readOnly:true});
    db.exec('BEGIN');db.prepare('SELECT count(*) FROM cache_entries').get();
    console.log('ready');
    for await(const chunk of process.stdin) {};
    db.close();
  `,
      file,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  const ready = await Promise.race([
    once(child.stdout, "data").then(([data]) => String(data).trim()),
    exited.then(([code]) => {
      throw new Error(`Foreign reader exited before readiness: ${code}`);
    }),
  ]);
  if (ready !== "ready") {
    child.stdin.end();
    await exited;
    throw new Error("Foreign reader did not establish its real read transaction");
  }
  return {
    child,
    async close() {
      child.stdin.end();
      await exited;
    },
  };
}

/** Open the real independent auth read pool, retaining its actual handles for lifetime checks. */
export function openCandidateAuthReaders(files: string[]) {
  const opened = vi.spyOn(sqlite, "openNodeSqliteDatabase");
  try {
    for (const file of files) {
      const result = inspectAuthProfileJsonCellReadOnly({ kind: "agent", path: file }, "store");
      expect(result.status).not.toBe("unreadable");
    }
    expect(opened).toHaveBeenCalledTimes(files.length);
    return opened.mock.results.map((result) => {
      if (result.type !== "return") {
        throw new Error("Pooled auth reader did not open");
      }
      expect(result.value.isOpen).toBe(true);
      return result.value;
    });
  } finally {
    opened.mockRestore();
  }
}
