import os from "node:os";
import { describe, it } from "vitest";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import {
  laterBoot,
  linux,
  namespace,
  rebooted,
  repair,
  running,
  stillRefuses,
  unleased,
  type Dead,
  type RefusalCase,
} from "./update-command-killed-run.process.test-support.js";

// The restart rule: after a machine restart empties the lease store, only a recorded
// earlier boot of this same host shows the killed updater's processes gone.
describe.skipIf(process.platform === "win32")("next update after a killed update run", () => {
  // Each of these leaves the updater's processes unproven after the lease store was lost.
  it.each<RefusalCase>([
    ...(
      [
        ["the lease store was lost within the same boot", [linux()], linux()],
        ["an older version recorded the run without its boot", [undefined], linux(laterBoot)],
        ["the run recorded that its boot was unknown", [null], linux(laterBoot)],
        ["one of the run's drivers recorded no boot", [linux(), undefined], linux(laterBoot)],
        [
          "the machine identity is unknown on both boots",
          [namespace({ platform: "linux", machine: null })],
          namespace({ platform: "linux", boot: laterBoot, machine: null }),
        ],
        [
          "the run was recorded on another machine",
          [namespace({ platform: "linux", machine: "b".repeat(64) })],
          linux(laterBoot),
        ],
        [
          // A container restart is not a host restart, and container identities can repeat.
          "the run and this update ran in the same Linux PID namespace other than the host's",
          [namespace({ platform: "linux", pid: "pid:[4026532001]" })],
          namespace({ platform: "linux", boot: laterBoot, pid: "pid:[4026532001]" }),
        ],
        [
          "this update runs in a Linux PID namespace other than the host's",
          [linux()],
          namespace({ platform: "linux", boot: laterBoot, pid: "pid:[4026532001]" }),
        ],
        [
          "the run was recorded in a Linux PID namespace other than the host's",
          [namespace({ platform: "linux", pid: "pid:[4026532001]" })],
          linux(laterBoot),
        ],
        [
          "one of the run's drivers ran in this boot",
          [linux(), linux(laterBoot)],
          linux(laterBoot),
        ],
        [
          "the run was recorded on another platform",
          [namespace({ platform: "darwin" })],
          linux(laterBoot),
        ],
      ] as const
    ).map(([name, drivers, current]) => ({
      name,
      refusal: unleased,
      control: rebooted([...drivers], current),
    })),
    {
      // A container sharing the host's PID namespace still carries an image's identity.
      name: "this update runs in a container that shares the host's PID namespace",
      refusal: unleased,
      control: rebooted([linux()], linux(laterBoot), { container: true }),
    },
    {
      // A clone sharing this host's name, machine identity and state boots on its own.
      name: "the run kept writing after this boot began",
      refusal: unleased,
      control: rebooted([linux()], linux(laterBoot), { bootedBeforeLastWrite: true }),
    },
    {
      // Abandonment already refuses it; the restart rule never reads its other drivers.
      name: "the run lost its updater's identity before a restart",
      refusal: running,
      control: async (killed: Dead) => {
        const step = { step: "driver:identity-unavailable", status: "completed" } as const;
        recordUpdateRunStep(killed.runId, { ...step, endedAtMs: Date.now() });
        await rebooted([linux()], linux(laterBoot))(killed);
      },
    },
    {
      name: "a managed helper had adopted the run before a restart",
      refusal: new RegExp(`not left by a killed openclaw update command.*${repair}`, "u"),
      control: (killed: Dead) => {
        const driver = { host: os.hostname(), pid: killed.proc.pid!, startIdentity: "1" };
        const managedHandoff = { parent: driver, helper: driver };
        return rebooted([linux()], linux(laterBoot), { origin: { managedHandoff } })(killed);
      },
    },
  ])("still refuses when $name", stillRefuses);
});
