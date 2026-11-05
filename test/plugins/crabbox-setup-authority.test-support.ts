import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { resolveNodeRuntimeExecutable } from "../../src/infra/node-runtime-executable.js";
import { createDeferredCore } from "../../src/shared/deferred.js";

/** External CLI/provider transport only. Gateway authority and process execution stay real. */
export async function createSetupCommandFixture(root: string, retry = false) {
  // The test harness may run under Bun, whose "run" token is a CLI command.
  const binary = resolveNodeRuntimeExecutable();
  if (!binary) {
    throw new Error("The local native CLI fixture requires a real Node executable");
  }
  const home = path.join(root, "native-cli");
  await fs.mkdir(home);
  const firstAttempt = createDeferredCore();
  const releaseRetry = createDeferredCore();
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/retry") {
      response.writeHead(404).end();
      return;
    }
    firstAttempt.resolve();
    void releaseRetry.promise.then(() => response.end("continue"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture listener did not provide an address");
  }
  const io = path.join(home, "io.log");
  const effect = path.join(home, "effect.txt");
  const token = randomUUID();
  await fs.writeFile(io, "");
  await fs.writeFile(effect, "not-run");
  await fs.writeFile(path.join(home, "package.json"), '{"type":"commonjs"}');
  // The real runner launches Node as a tiny Crabbox argv/stdin/profile adapter.
  // Its setup language is deliberately JavaScript, not a claim about remote shells.
  const program = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const crypto = require('node:crypto');",
    "const { spawnSync } = require('node:child_process');",
    "const config = " +
      JSON.stringify({ retry, url: "http://127.0.0.1:" + address.port + "/retry" }) +
      ";",
    "const io = path.join(__dirname, 'io.log');",
    "const command = path.basename(process.argv[1]);",
    "fs.appendFileSync(io, command + '\\n');",
    "if (process.argv[process.argv.indexOf('--provider') + 1] !== 'azure-sandbox' || process.argv[process.argv.indexOf('--id') + 1] !== 'lease-1') throw new Error('Unexpected fixture lease scope');",
    "if (command === 'stop') process.exit(0);",
    "if (command !== 'run' || !process.argv.includes('--script-stdin')) throw new Error('Unexpected fixture command');",
    "const input = fs.readFileSync(0, 'utf8');",
    "const index = process.argv.indexOf('--env-from-profile');",
    "if (index < 0) throw new Error('Missing real environment profile');",
    "const profile = Object.fromEntries(fs.readFileSync(process.argv[index + 1], 'utf8').trim().split('\\n').map(line => { const equals = line.indexOf('='); return [line.slice(0, equals), JSON.parse(line.slice(equals + 1))]; }));",
    "fs.appendFileSync(io, 'stdin:' + crypto.createHash('sha256').update(input).digest('hex') + ':inherited=' + (process.env.PROOF_TOKEN !== undefined) + '\\n');",
    "const attempts = fs.readFileSync(io, 'utf8').split('\\n').filter(line => line === 'run').length;",
    "if (config.retry && attempts === 1) {",
    "  fetch(config.url, { method: 'POST' }).then(response => response.text()).then(() => { process.stderr.write('Get \"https://coordinator.invalid/v1/leases/fixture\": context deadline exceeded\\n'); process.exit(2); }).catch(error => { console.error(error); process.exit(1); });",
    "} else {",
    "  const result = spawnSync(process.execPath, ['-e', input], { cwd: __dirname, env: { ...process.env, ...profile }, encoding: 'utf8' });",
    "  if (result.error) throw result.error;",
    "  process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);",
    "}",
  ].join("\n");
  await fs.writeFile(path.join(home, "run"), program);
  await fs.writeFile(path.join(home, "stop"), program);
  const setup =
    "require('node:fs').writeFileSync(process.env.PROOF_OUTPUT, process.env.PROOF_TOKEN);";
  return {
    home,
    binary,
    setup,
    setupDigest: createHash("sha256").update(setup).digest("hex"),
    forwardedEnv: { PROOF_TOKEN: token, PROOF_OUTPUT: effect },
    token,
    firstAttempt: firstAttempt.promise,
    releaseRetry: releaseRetry.resolve,
    events: async () => (await fs.readFile(io, "utf8")).split("\n").filter(Boolean),
    effect: () => fs.readFile(effect, "utf8"),
    close: async () => {
      releaseRetry.resolve();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
