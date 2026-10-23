import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../../test/helpers/fixture-lifetime.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import type { UpdateStepResult } from "../../infra/update-step-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import { runUpdateFinalizationDoctorInFreshProcess } from "./update-command-fresh-doctor.js";

const custody = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.doctorCustody);
const lifetime = createFixtureLifetime();
afterEach(async () => {
  try {
    await lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

it(
  "times out a stuck post-activation Doctor and settles its worker tree without an operator timeout",
  {
    timeout: 15_000,
  },
  async ({ signal }) => {
    await lifetime.run(() =>
      withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const entryPath = state.path("doctor.mjs");
        const pidsPath = state.path("doctor-pids.json");
        fs.writeFileSync(
          entryPath,
          `import fs from "node:fs";
import { spawn } from "node:child_process";
${custody.pathname.endsWith(".ts") ? `await import(${JSON.stringify(new URL("../../../scripts/tsx.mjs", import.meta.url).href)});` : ""}
const { retainUpdateDoctorProcesses } = await import(${JSON.stringify(custody.href)});
// Use Doctor's actual custody publication; this fixture deliberately never completes.
await retainUpdateDoctorProcesses();
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1000);'], {
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});
child.once("message", () => fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify([process.pid, child.pid])));
setInterval(() => {}, 1000);
`,
        );
        const steps: UpdateStepResult[] = [];
        vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
        const work = withCommandProcessScope(
          () =>
            runUpdateFinalizationDoctorInFreshProcess({
              phase: "post-plugin",
              root: state.root,
              entryPath,
              nodeRunner: process.execPath,
              opts: {},
              timeoutMs: 3_000,
              yes: true,
              json: true,
              onDoctorStep: (step) => steps.push(step),
            }),
          signal,
        );

        if (process.platform === "win32") {
          // Windows custody retains its existing refusal after forced tree cleanup.
          await expect(work).rejects.toMatchObject({
            code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN",
          });
          expect(steps).toContainEqual(
            expect.objectContaining({ name: "doctor process settlement", exitCode: 1 }),
          );
        } else {
          const warning = await work;
          expect(warning).toMatchObject({
            reason: "doctor-advisory",
            message: expect.stringContaining("exit 124"),
            guidance: ["Run `openclaw update repair` to retry post-update plugin repair."],
          });
          expect(steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: "doctor process settlement",
                exitCode: 0,
                advisory: {
                  kind: "recoverable-maintenance",
                  message: expect.stringContaining("Preserving migrated state"),
                },
              }),
            ]),
          );
        }
        const pids: number[] = JSON.parse(fs.readFileSync(pidsPath, "utf8"));
        expect(pids).toHaveLength(2);
        for (const pid of pids) {
          expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
        }
      }),
    );
  },
);
