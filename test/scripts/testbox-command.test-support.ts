import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// These executable fixtures prove orchestration, not pnpm's reconciliation algorithm.
// Receipts live outside the checkout so Git reconstruction cannot erase the evidence.
export function createTestboxCommandFixture(root: string) {
  const bin = path.join(root, "bin");
  const events = path.join(root, "events.jsonl");
  const receipt = path.join(root, "installed-input");
  const payload = path.join(bin, "payload");
  const modules = path.join(root, "hydrated-modules");
  mkdirSync(modules, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(receipt, "hydrated\n");
  const common = `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const input = fs.readFileSync('owner.txt', 'utf8');
const gitStatus = spawnSync('git', ['status', '--porcelain=v1'], { encoding: 'utf8' });
const record = (phase) => fs.appendFileSync(${JSON.stringify(events)}, JSON.stringify({
  phase, input, cwd: fs.realpathSync('.'), args: process.argv.slice(2), ci: process.env.CI,
  packageManager: JSON.parse(fs.readFileSync('package.json', 'utf8')).packageManager,
  clean: gitStatus.status === 0 && gitStatus.stdout === '',
  modulesExposed: fs.existsSync('node_modules') && fs.realpathSync('node_modules') === fs.realpathSync(${JSON.stringify(modules)}),
}) + '\\n');
`;
  writeFileSync(
    payload,
    `#!/usr/bin/env node\n${common}
record('payload');
if (fs.readFileSync(${JSON.stringify(receipt)}, 'utf8') !== input) {
  console.error('payload saw stale installed inputs'); process.exit(91);
}
console.log(JSON.stringify({ input, args: process.argv.slice(2) }));
process.exit(Number(process.env.TESTBOX_FIXTURE_PAYLOAD_EXIT || 0));
`,
  );
  const corepack = path.join(bin, "corepack");
  writeFileSync(
    corepack,
    `#!/usr/bin/env node\n${common}
const args = process.argv.slice(2);
if (JSON.stringify(args) === JSON.stringify(['pnpm', 'install', '--frozen-lockfile'])) {
  record('install');
  console.log('frozen install preparation');
  const failure = Number(process.env.TESTBOX_FIXTURE_INSTALL_EXIT || 0);
  if (failure) process.exit(failure);
  fs.writeFileSync(${JSON.stringify(receipt)}, input);
} else if (args[0] === 'pnpm' && ['test', 'check:changed'].includes(args[1])) {
  const result = spawnSync(${JSON.stringify(payload)}, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
} else { console.error('unexpected corepack arguments', args); process.exit(92); }
`,
  );
  for (const file of [payload, corepack]) {
    chmodSync(file, 0o755);
  }
  return {
    bin,
    payload,
    readEvents() {
      return existsSync(events)
        ? readFileSync(events, "utf8")
            .trim()
            .split("\n")
            .map(
              (line) =>
                JSON.parse(line) as {
                  phase: string;
                  input: string;
                  cwd: string;
                  args: string[];
                  ci: string;
                  packageManager: string;
                  clean: boolean;
                  modulesExposed: boolean;
                },
            )
        : [];
    },
    run(cwd: string, command: string, env: NodeJS.ProcessEnv = {}) {
      return spawnSync("bash", ["-c", command], {
        cwd,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          CRABBOX_PNPM_MODULES_DIR: modules,
          PNPM_CONFIG_MODULES_DIR: "",
          ...env,
          PATH: [bin, path.dirname(process.execPath), env.PATH ?? process.env.PATH].join(
            path.delimiter,
          ),
        },
      });
    },
  };
}
