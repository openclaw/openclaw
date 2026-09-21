// Isolated observer: the parent bounds this entire probe, including native reads.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const pid = Number(process.argv[2]);
const processLimit = 32;
const threadLimit = 64;
const nativeThreadRoles = new Map([
  ["V8Worker", "v8-worker"],
  ["DelayedTaskSche", "delayed-task-scheduler"],
  ["SignalInspector", "signal-inspector"],
  ["libuv-worker", "libuv-worker"],
]);

function read(file) {
  try {
    return fs.readFileSync(file, "utf8").trim().slice(0, 4096);
  } catch (error) {
    return `unavailable (${error.code ?? "read failed"})`;
  }
}

// No argv or environment. Only fixed native thread roles are emitted below.
const rows = execFileSync("ps", ["-axo", "pid=,ppid=,stat=,wchan="], {
  encoding: "utf8",
  timeout: 500,
  killSignal: "SIGKILL",
  maxBuffer: 1024 * 1024,
})
  .trim()
  .split("\n")
  .map((line) => {
    const [id, parent, state, ...wait] = line.trim().split(/\s+/u);
    return { pid: Number(id), ppid: Number(parent), state, wchan: wait.join(" ") };
  });
const tree = rows.filter((row) => row.pid === pid);
for (let i = 0; i < tree.length && tree.length < processLimit; i++) {
  for (const row of rows) {
    if (row.ppid === tree[i].pid && !tree.some((entry) => entry.pid === row.pid)) {
      tree.push(row);
      if (tree.length === processLimit) {
        break;
      }
    }
  }
}
console.log(`root pid=${pid}; process limit=${processLimit}; thread limit=${threadLimit}`);
if (tree.length === 0) {
  console.log("Root absent from ps snapshot (already exited or reaped).");
}
for (const row of tree) {
  console.log(JSON.stringify(row));
  if (process.platform !== "linux") {
    continue;
  }
  const root = `/proc/${row.pid}`;
  let threads;
  try {
    threads = fs.readdirSync(`${root}/task`);
  } catch (error) {
    console.log(`Threads unavailable (${error.code ?? "read failed"})`);
    continue;
  }
  for (const tid of threads.slice(0, threadLimit)) {
    const base = `${root}/task/${tid}`;
    const signals = read(`${base}/status`)
      .split("\n")
      .filter((line) => /^(State|TracerPid|SigPnd|ShdPnd|SigBlk|SigIgn|SigCgt):/u.test(line));
    console.log(
      JSON.stringify({
        pid: row.pid,
        tid: Number(tid),
        role: Number(tid) === row.pid ? "main" : nativeThreadRoles.get(read(`${base}/comm`)),
        wchan: read(`${base}/wchan`),
        stack: read(`${base}/stack`),
        signals,
      }),
    );
  }
  if (threads.length > threadLimit) {
    console.log(`Threads truncated: ${threads.length}`);
  }
}
if (tree.length === processLimit) {
  console.log("Process limit reached; tree may be truncated.");
}
