import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { requireNodeTool } from "../../../test/helpers/node-toolchain.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { processProbeEntrypoints } from "../process-probes-runtime.test-support.js";

it.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))(
  "retires A/B and failed startup with real kernel-denied group signals and complete output",
  async () => {
    const fixture = resolveRuntimeWorkerUrl(processProbeEntrypoints.serviceChildSubreaper);
    const node = requireNodeTool("node");
    const { stdout } = await promisify(execFile)(node, resolveRuntimeWorkerArgv(fixture, node), {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(JSON.parse(stdout)).toEqual([
      ...["A", "B"].map((label) => ({
        label,
        code: 0,
        signal: null,
        stdout: label + "-final-output",
        extinct: true,
        owner: "linux-subreaper",
      })),
      {
        label: "graceful-term",
        code: 23,
        signal: null,
        stdout: "",
        extinct: true,
        owner: "linux-subreaper",
      },
      {
        label: "startup-failed",
        code: null,
        signal: null,
        stdout: "",
        extinct: true,
        owner: "linux-subreaper",
      },
    ]);
  },
);
