import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import { processProbeEntrypoints } from "../process-probes-runtime.test-support.js";

it.skipIf(process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))(
  "reaps adopted children and preserves root results with kernel-denied group signals",
  async () => {
    const fixture = resolveRuntimeWorkerUrl(processProbeEntrypoints.serviceChildSubreaper);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      resolveRuntimeWorkerArgv(fixture),
      { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 },
    );
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
      { label: "realtime-signal", signalNumber: 34, extinct: true },
      { label: "active-root-orphan", code: 37, signal: null, extinct: true },
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
