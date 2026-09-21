import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { triageTestRuntimeEntrypoints } from "./triage-runtime.test-support.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { createTriageBoundary } from "./update-managed-service-triage.test-support.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

// Change only the existing synthetic /proc boundary. The producer's complete
// generated handoff, both admission sites, IPC and lease owner still execute.
async function setCgroupMembership(
  root: string,
  membership: string,
  target: "both" | "helper" | "executor" = "both",
) {
  await fs.appendFile(
    path.join(root, "placement.cjs"),
    `
const readMembership = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const value = readMembership.call(this, file, ...args);
  if (typeof file !== 'string' || !/^\\/proc\\/(self|[0-9]+)\\/cgroup$/.test(file)) return value;
  const consumer = file === '/proc/self/cgroup' ? 'helper' : 'executor';
  event('cgroup-' + consumer);
  if (${JSON.stringify(target)} !== 'both' && consumer !== ${JSON.stringify(target)}) return value;
  return ${JSON.stringify(membership)}.replaceAll('$GROUP', value.trim().slice(3));
};
`,
  );
}

const itUnix = it.runIf(process.platform !== "win32");

itUnix.each([
  { format: "v2", membership: "0::$GROUP\n" },
  { format: "multiline v2", membership: "5:cpu:/unrelated\n0::$GROUP\n2:memory:/other\n" },
  { format: "v1", membership: "12:memory:/unrelated\n1:name=systemd:$GROUP\n3:cpu:/other\n" },
  { format: "v1 last line", membership: "3:cpu:/unrelated\n15:name=systemd:$GROUP\n" },
  { format: "hybrid", membership: "0::/unrelated\n4:cpu,cpuacct:/other\n7:name=systemd:$GROUP\n" },
])(
  "finishes the original update before the native fixer starts without lending its run identity ($format)",
  async ({ membership }) => {
    let runId = "";
    let runEnv: NodeJS.ProcessEnv = {};
    const boundary = await createTriageBoundary(
      "update",
      undefined,
      undefined,
      async (root, env) => {
        await setCgroupMembership(root, membership);
        runEnv = env;
        runId = createUpdateRun({ trigger: "cli" }, { env }).runId;
        env[UPDATE_RUN_ID_ENV] = runId;
        const ledgerUrl = resolveRuntimeWorkerUrl(
          triageTestRuntimeEntrypoints.updateRunLedger,
        ).href;
        const recoveryModulePath = path.join(root, "ledger.mjs");
        await fs.writeFile(recoveryModulePath, `export * from ${JSON.stringify(ledgerUrl)};`);
        const paramsPath = path.join(root, "handoff.json");
        const params = JSON.parse(await fs.readFile(paramsPath, "utf8"));
        await fs.writeFile(
          paramsPath,
          JSON.stringify({ ...params, runId, recoveryModulePath, recoveryTimeoutMs: 5000 }),
        );
        const updaterPath = path.join(root, "updater.cjs");
        await fs.writeFile(
          updaterPath,
          (await fs.readFile(updaterPath, "utf8")).replace(
            "reason:'original failure'",
            `reason:'original failure',mode:'npm',root:${JSON.stringify(root)}`,
          ),
        );
        const candidatePath = path.join(root, "candidate.mjs");
        const candidate = await fs.readFile(candidatePath, "utf8");
        await fs.writeFile(
          candidatePath,
          `import { getUpdateRun } from ${JSON.stringify(ledgerUrl)};\n` +
            candidate.replace(
              "event('fixer',",
              `event('ledger-before-fixer',{result:getUpdateRun(${JSON.stringify(runId)}),inheritedRunId:process.env[${JSON.stringify(UPDATE_RUN_ID_ENV)}]??null});\nevent('fixer',`,
            ),
        );
      },
    );
    try {
      expect(await boundary.response()).toBe("OPENCLAW_UPDATE_HANDOFF_READY");
      expect(await boundary.control("park")).toBe("parked");
      expect(await boundary.control("commit")).toBe("committed");
      boundary.parent.kill();
      await vi.waitFor(
        async () => {
          expect(
            (await boundary.readEvents()).find((event) => event.kind === "ledger-before-fixer"),
            await boundary.log(),
          ).toMatchObject({
            result: {
              runId,
              status: "failed",
              phase: "finished",
              reason: "managed-service-handoff-failed",
            },
            inheritedRunId: null,
          });
        },
        { timeout: 15_000 },
      );
      expect(await boundary.log()).toContain('"reason":"original failure"');
      const events = await boundary.readEvents();
      expect(events.some((event) => event.kind === "cgroup-helper")).toBe(true);
      expect(events.some((event) => event.kind === "cgroup-executor")).toBe(true);
      const terminal = getUpdateRun(runId, { env: runEnv });
      await boundary.native("stop");
      await boundary.exit;
      expect(getUpdateRun(runId, { env: runEnv })).toEqual(terminal);
    } finally {
      await boundary.cleanup();
    }
  },
);

for (const target of ["helper", "executor"] as const) {
  itUnix.each([
    { reason: "missing membership", membership: "" },
    { reason: "wrong v2 path", membership: "0::/foreign.scope\n" },
    { reason: "v2 descendant", membership: "0::$GROUP/child\n" },
    { reason: "v2 prefix lookalike", membership: "0::$GROUP-other\n" },
    { reason: "v2 suffix lookalike", membership: "0::/prefix$GROUP\n" },
    { reason: "nonzero v2 hierarchy", membership: "1::$GROUP\n" },
    { reason: "wrong v1 controller", membership: "1:cpu:$GROUP\n" },
    { reason: "controller suffix lookalike", membership: "1:notname=systemd:$GROUP\n" },
    { reason: "v1 controller list", membership: "1:cpu,name=systemd:$GROUP\n" },
    { reason: "nonnumeric hierarchy", membership: "x:name=systemd:$GROUP\n" },
    { reason: "negative hierarchy", membership: "-1:name=systemd:$GROUP\n" },
    { reason: "zero v1 hierarchy", membership: "0:name=systemd:$GROUP\n" },
    { reason: "v1 descendant", membership: "1:name=systemd:$GROUP/child\n" },
    { reason: "v1 prefix lookalike", membership: "1:name=systemd:$GROUP-other\n" },
    { reason: "v1 suffix lookalike", membership: "1:name=systemd:/prefix$GROUP\n" },
    { reason: "path whitespace", membership: "1:name=systemd:$GROUP \n" },
    {
      reason: "unrelated hybrid memberships",
      membership: "0::/unrelated\n1:name=systemd:/foreign.scope\n2:cpu:$GROUP\n",
    },
  ])(`refuses ${target} $reason before the fixer starts`, async ({ membership }) => {
    const boundary = await createTriageBoundary("startup", undefined, undefined, (root) =>
      setCgroupMembership(root, membership, target),
    );
    try {
      if (target === "executor") {
        expect(await boundary.response()).toBe("OPENCLAW_UPDATE_HANDOFF_READY");
        expect(await boundary.control("commit")).toBe("committed");
      }
      await boundary.exit;
      const events = await boundary.readEvents();
      expect(events.some((event) => event.kind === `cgroup-${target}`)).toBe(true);
      expect(events.filter((event) => event.kind === "fixer")).toEqual([]);
      expect(await boundary.log()).toContain(
        target === "helper"
          ? "native scope ownership could not be verified"
          : "executor lost its native placement",
      );
      if (target === "helper") {
        expect(boundary.output()).not.toContain("READY");
      }
    } finally {
      await boundary.cleanup();
    }
  });
}
