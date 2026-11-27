import path from "node:path";

export function createHandoffLifetimePreload({
  callerPath,
  root,
  leasePath,
  tracePath,
  mode,
}: {
  callerPath: string;
  root: string;
  leasePath: string;
  tracePath: string;
  mode: "cancel" | "cancel-output-first" | "transfer";
}): string {
  return `
const fs=require('node:fs');
const record=(event,data={})=>fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({event,...data})+'\\n');
// NODE_OPTIONS also preloads the state worker, whose argv[1] is not the caller.
// Its PID is shared with the caller; the detached helper must still publish cancellation.
if(process.argv[1]===${JSON.stringify(callerPath)}) process.env.OPENCLAW_TEST_HANDOFF_CALLER_PID=String(process.pid);
if(process.env.OPENCLAW_TEST_HANDOFF_CALLER_PID===String(process.pid) && ${mode !== "transfer"}) {
  const {DatabaseSync}=require('node:sqlite'), prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql) {
    if(this.location()===${JSON.stringify(path.join(root, "state/openclaw.sqlite"))} && /^insert into "gateway_restart_sentinel"/i.test(sql)) {
      const db=new DatabaseSync(${JSON.stringify(leasePath)},{readOnly:true});
      const lease=db.prepare('SELECT owner FROM managed_update_handoffs WHERE install_root=?').get(${JSON.stringify(root)});
      db.close();record('publication-denied',{ready:!!lease});
      throw Object.assign(new Error('fixture publication denied'),{code:'SQLITE_CANTOPEN'});
    }
    return prepare.call(this,sql);
  };
}
if(process.argv[1]?.endsWith('/handoff.cjs')) {
  const params=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  if(params.updateLeaseKey===${JSON.stringify(root)}) {
    if(params.updateLeaseDatabasePath!==${JSON.stringify(leasePath)} || params.updateLeaseDatabaseIdentity?.databasePath!==${JSON.stringify(leasePath)}) {
      throw new Error("Fixture handoff escaped its private lease database");
    }
    if(${mode === "cancel-output-first"}) {
      // Close only helper output before native exit; the initiating CLI has no keepalive.
      process.once('beforeExit',()=>{record('helper-output-closed');process.stdout.end();setTimeout(()=>{},100);});
    }
    process.once('exit',()=>record('helper-exit'));
  }
}`;
}
