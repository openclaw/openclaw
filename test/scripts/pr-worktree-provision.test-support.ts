import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type CheckoutFault =
  | "retained-gitfile"
  | "removed-gitfile"
  | "rejected"
  | "slow-cleanup"
  | "external-cancel";

/** Clock control starts only after the real owner admits a materializing Git child. */
export function installCheckoutDeadline(
  f: { root: string; env: NodeJS.ProcessEnv },
  fault?: CheckoutFault,
) {
  const receipt = join(f.root, "checkout-deadline.json");
  const checkout = join(f.root, "controlled-checkout.mjs");
  const preload = join(f.root, "checkout-clock.mjs");
  writeFileSync(
    checkout,
    `import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const [git, ...args] = process.argv.slice(2);
const command = args.indexOf('worktree');
const destination = command >= 0 ? args[args.lastIndexOf('--') + 1] : args[args.indexOf('-C') + 1];
const root = ${JSON.stringify(f.root)};
const fault = ${JSON.stringify(fault ?? null)};
function run(argv) {
  const result = spawnSync(git, argv, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (fault === 'rejected') {
  run([...args.slice(0, command), 'worktree', 'add', '--no-checkout', '--',
    join(root, 'seed-sibling'), args.at(-1)]);
  run(args);
  throw new Error('Expected Git to refuse a branch already owned by a sibling');
}
if (command >= 0) {
  const register = [...args];
  register.splice(command + 2, 0, '--no-checkout');
  run(register);
}
mkdirSync(join(destination, 'src'), { recursive: true });
writeFileSync(join(destination, 'src', 'file-0.txt'), 'checkout progress\\n');
const admin = resolve(destination, readFileSync(join(destination, '.git'), 'utf8').trim().slice(8));
function awaitRelease(expected, ready, complete) {
  const listener = message => {
    if (message !== expected) return;
    process.off('message', listener);
    complete();
  };
  process.on('message', listener);
  console.error(ready + process.pid);
  return () => process.off('message', listener);
}
let progressing;
process.once('disconnect', () => process.exit(2));
process.on('SIGTERM', () => {
  progressing?.();
  if (fault === 'slow-cleanup' || fault === 'external-cancel') {
    if (command >= 0) rmSync(admin, { recursive: true });
    awaitRelease('cleanup-release', 'FIXTURE_CLEANUP_READY:', () => {
      if (command >= 0) rmSync(destination, { recursive: true });
      writeFileSync(join(root, 'cleanup-complete'), 'Git cleanup completed');
      process.exit(143);
    });
    return;
  }
  // Git deletes registration first; forced termination can interrupt its
  // subsequent checkout walk, before or after removal of the .git file.
  rmSync(admin, { recursive: true });
  if (fault === 'removed-gitfile') rmSync(join(destination, '.git'));
  process.exit(143);
});
progressing = awaitRelease('checkout-release', 'FIXTURE_CHECKOUT_READY:', () => {
  run(command >= 0 ? ['-C', destination, 'reset', '--hard', 'HEAD'] : args);
  process.exit(0);
});
`,
  );
  writeFileSync(
    preload,
    `import childProcess from 'node:child_process';
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const external = ${fault === "external-cancel"};
const allocatorPid = ${JSON.stringify(join(f.root, "allocator.pid"))};
if (external && process.argv[1]?.endsWith('/process-group-runner.mjs')) {
  const spawn = childProcess.spawn;
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const timers = new Map();
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    const timer = schedule(() => {
      timers.delete(timer);
      callback(...args);
    }, milliseconds);
    if (milliseconds >= 5000) timers.set(timer, { callback, milliseconds, args });
    return timer;
  };
  globalThis.clearTimeout = timer => {
    timers.delete(timer);
    return cancel(timer);
  };
  childProcess.spawn = (command, args, options) => {
    const child = spawn(command, args, options);
    let output = '';
    let sideEffects = 0;
    child.stdio[3].on('data', chunk => {
      output += chunk.toString();
      let newline;
      while ((newline = output.indexOf('\\n')) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        if (line === 'phase\\tside-effects-started' && ++sideEffects === 2) {
          // The production consumer runs synchronously after this observer.
          queueMicrotask(() => process.kill(Number(readFileSync(allocatorPid, 'utf8')), 'SIGUSR2'));
        }
      }
    });
    return child;
  };
  syncBuiltinESMExports();
  process.on('SIGUSR2', () => {
    if (timers.size !== 1) throw new Error('Expected one pending supervisor escalation');
    const [timer, deadline] = [...timers][0];
    writeFileSync(${JSON.stringify(join(f.root, "supervisor-grace.json"))},
      JSON.stringify({ elapsed: 5001, grace: deadline.milliseconds }));
    if (deadline.milliseconds <= 5001) {
      cancel(timer);
      timers.delete(timer);
      deadline.callback(...deadline.args);
      return;
    }
    try {
      process.kill(Number(readFileSync(allocatorPid, 'utf8')), 'SIGUSR2');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  });
}
if (process.argv[1]?.endsWith('/worktree-provision.mts')) {
  const spawn = childProcess.spawn;
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const now = Date.now;
  const kill = process.kill;
  const timers = new Map();
  const evidence = { signals: [] };
  let checkoutChild;
  let advanced = 0;
  let frozenNow;
  Date.now = () => frozenNow ?? now() + advanced;
  const save = () => writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(evidence));
  globalThis.setTimeout = (callback, milliseconds, ...args) => {
    const timer = schedule(() => {
      timers.delete(timer);
      callback(...args);
    }, milliseconds);
    if (checkoutChild) timers.set(timer, { callback, milliseconds, args });
    return timer;
  };
  globalThis.clearTimeout = timer => {
    timers.delete(timer);
    return cancel(timer);
  };
  function fire(timer, deadline) {
    cancel(timer);
    timers.delete(timer);
    deadline.callback(...deadline.args);
  }
  process.kill = (pid, signal) => {
    if (checkoutChild && pid === -checkoutChild.pid && signal !== 0) {
      evidence.signals.push(signal);
      save();
    }
    return kill(pid, signal);
  };
  childProcess.spawn = (command, args, options) => {
    const index = args?.indexOf('worktree') ?? -1;
    const materializes = (index >= 0 && args[index + 1] === 'add' && !args.includes('--no-checkout')) ||
      (args?.includes('read-tree') && args.includes('-u'));
    if (!materializes) return spawn(command, args, options);
    if (!Array.isArray(options.stdio)) throw new Error('Expected checkout stdio descriptors');
    const child = spawn(process.execPath, [${JSON.stringify(checkout)}, command, ...args], {
      ...options,
      stdio: [...options.stdio, 'ipc'],
    });
    const release = message => child.send(message, error => {
      if (error) {
        evidence.releaseError = error.code;
        save();
      }
    });
    let acknowledged = false;
    let readyForCancellation = false;
    let cancellationSent = false;
    let cleaning = false;
    const cancelAcknowledgedCheckout = () => {
      if (!acknowledged || !readyForCancellation || cancellationSent) return;
      cancellationSent = true;
      // Isolate the outer five-second deadline from Git's older 300 ms grace.
      frozenNow = now();
      process.kill(Number(process.env.OPENCLAW_PR_LOCK_SUPERVISOR_PID), 'SIGTERM');
    };
    const releaseCleanup = () => {
      if (!acknowledged) {
        acknowledged = true;
        cancelAcknowledgedCheckout();
      } else {
        if (!cleaning) throw new Error('Unexpected cleanup acknowledgement');
        frozenNow = undefined;
        release('cleanup-release');
      }
    };
    if (external) {
      // The PID handoff precedes the signal; no directory notification or polling.
      writeFileSync(allocatorPid, String(process.pid));
      process.on('SIGUSR2', releaseCleanup);
      // This idempotent marker follows the production grace announcement on
      // the same pipe; the supervisor acknowledges its actual consumption.
      writeSync(Number(process.env.OPENCLAW_PR_LOCK_NOTIFY_FD), 'phase\\tside-effects-started\\n');
    }
    checkoutChild = child;
    child.once('exit', () => {
      checkoutChild = undefined;
      process.off('SIGUSR2', releaseCleanup);
    });
    let output = '';
    child.stderr.on('data', chunk => {
      output += chunk.toString();
      let newline;
      while ((newline = output.indexOf('\\n')) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        const ready = /^FIXTURE_CHECKOUT_READY:(\\d+)$/.exec(line);
        if (ready) {
          const deadlines = [...timers].filter(([, value]) => value.milliseconds >= 300000);
          if (deadlines.length !== 1) throw new Error('Expected one admitted checkout deadline');
          const [timer, deadline] = deadlines[0];
          evidence.elapsed = external ? 0 : ${Boolean(fault)} ? deadline.milliseconds : 300001;
          evidence.deadline = deadline.milliseconds;
          save();
          if (external) {
            readyForCancellation = true;
            cancelAcknowledgedCheckout();
          } else if (deadline.milliseconds <= evidence.elapsed) fire(timer, deadline);
          else release('checkout-release');
        }
        const cleanupReady = /^FIXTURE_CLEANUP_READY:(\\d+)$/.exec(line);
        if (cleanupReady) {
          if (external) {
            cleaning = true;
            process.kill(Number(process.env.OPENCLAW_PR_LOCK_SUPERVISOR_PID), 'SIGUSR2');
            continue;
          }
          // Cross the former 300 ms cleanup grace at an acknowledged live
          // cleanup barrier, then drive its already-scheduled liveness poll.
          advanced += 301;
          evidence.cleanupElapsed = 301;
          const polls = [...timers].filter(([, value]) => value.milliseconds <= 300);
          if (!polls.length) throw new Error('Expected pending cleanup liveness poll');
          for (const [timer, deadline] of polls) fire(timer, deadline);
          save();
          release('cleanup-release');
        }
      }
    });
    return child;
  };
  syncBuiltinESMExports();
}
`,
  );
  f.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
  return receipt;
}
