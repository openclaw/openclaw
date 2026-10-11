// Turns a Doctor child's existing startup-trace phases into one bounded step diagnostic.
import { StringDecoder } from "node:string_decoder";
import type { CommandOutputStream } from "../process/exec-output.js";
import type { CommandOptions } from "../process/exec.js";
import { isTruthyEnvValue } from "./env.js";
import { UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";
import type { UpdateStepResult } from "./update-step-result.js";

const TRACE_ENV = "OPENCLAW_GATEWAY_STARTUP_TRACE";
const TRACE_MARKER = "[gateway] startup trace: ";
// measureGatewayBootstrapStep: `<name> <ms>ms total=…`; JSON console style embeds the same text.
const DOCTOR_TRACE = /\[gateway\] startup trace: doctor\.([^\s"]+) (\d+(?:\.\d+)?)ms(?=[\s"]|$)/u;
const CONTRIBUTION_PREFIX = "contribution.";
const MAX_PENDING_CHARS = 16 * 1024;
const MAX_PHASES = 256;
const SLOWEST_CONTRIBUTIONS = 5;

export type UpdateDoctorSectionTiming = {
  /** Enables the Doctor's existing trace phases in the child it is merged into. */
  readonly env: Readonly<Record<string, string>>;
  /** Observe one complete output line; never throws. */
  observeLine: (line: string) => void;
  /** Wrap a Doctor runner: observe stderr as it streams and drop trace lines from the result. */
  wrap: <R extends { stderr: string }>(
    run: (argv: string[], options: CommandOptions) => Promise<R>,
  ) => (argv: string[], options: CommandOptions) => Promise<R>;
  /** True for a trace line this updater enabled; operator-enabled tracing stays visible. */
  hidesLine: (line: string) => boolean;
  /** Remove trace lines this updater enabled. */
  stripTrace: (stderr: string) => string;
  /** Put the sections line first so diagnostic-count truncation keeps it. */
  annotate: <T extends Pick<UpdateStepResult, "diagnostics">>(step: T) => T;
};

/** Best effort: bookkeeping failures yield no line and never affect the Doctor. */
export function createUpdateDoctorSectionTiming(
  parentEnv: NodeJS.ProcessEnv = process.env,
): UpdateDoctorSectionTiming {
  const operatorTrace = isTruthyEnvValue(parentEnv[TRACE_ENV]);
  const phases = new Map<string, number>();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let droppingLine = false;

  const observeLine = (line: string) => {
    try {
      const match = DOCTOR_TRACE.exec(line);
      if (!match) {
        return;
      }
      const [, name, value] = match;
      const milliseconds = Number(value);
      if (!name || !Number.isFinite(milliseconds)) {
        return;
      }
      const previous = phases.get(name);
      if (previous !== undefined || phases.size < MAX_PHASES) {
        phases.set(name, (previous ?? 0) + milliseconds);
      }
    } catch {
      // Timing is diagnostic only.
    }
  };

  const observeStderr = (chunk: Buffer) => {
    try {
      let text = decoder.write(chunk);
      if (droppingLine) {
        const newline = text.indexOf("\n");
        if (newline < 0) {
          return;
        }
        text = text.slice(newline + 1);
        droppingLine = false;
      }
      const lines = `${pending}${text}`.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        observeLine(line);
      }
      if (pending.length > MAX_PENDING_CHARS) {
        pending = "";
        droppingLine = true;
      }
    } catch {
      // Timing is diagnostic only.
    }
  };

  const hidesLine = (line: string) => !operatorTrace && line.includes(TRACE_MARKER);
  const stripTrace = (stderr: string) =>
    operatorTrace || !stderr.includes(TRACE_MARKER)
      ? stderr
      : stderr
          .split("\n")
          .filter((line) => !hidesLine(line))
          .join("\n");

  const diagnostic = () => {
    try {
      if (pending) {
        observeLine(pending);
        pending = "";
      }
      const sections: string[] = [];
      const contributions: Array<[string, number]> = [];
      for (const [name, milliseconds] of phases) {
        if (name.startsWith(CONTRIBUTION_PREFIX)) {
          contributions.push([
            name.slice(CONTRIBUTION_PREFIX.length).replace(/^doctor:/u, ""),
            milliseconds,
          ]);
        } else {
          sections.push(`${name} ${(milliseconds / 1000).toFixed(1)} s`);
        }
      }
      const slowest = contributions
        .toSorted((left, right) => right[1] - left[1])
        .slice(0, SLOWEST_CONTRIBUTIONS)
        .map(([id, milliseconds]) => `${id} ${(milliseconds / 1000).toFixed(1)} s`);
      if (!sections.length && !slowest.length) {
        return undefined;
      }
      const line = [
        `Doctor sections: ${sections.length ? sections.join(", ") : "none"}`,
        ...(slowest.length ? [`slowest contributions: ${slowest.join(", ")}`] : []),
      ].join("; ");
      return line.length > UPDATE_RUN_TEXT_LIMIT
        ? `${line.slice(0, UPDATE_RUN_TEXT_LIMIT - 1)}…`
        : line;
    } catch {
      return undefined;
    }
  };

  return {
    env: { [TRACE_ENV]: "1" },
    observeLine,
    wrap: (run) => async (argv, options) => {
      const observer = options.onOutputChunk;
      const result = await run(argv, {
        ...options,
        onOutputChunk: (chunk: Buffer, stream: CommandOutputStream) => {
          if (stream === "stderr") {
            observeStderr(chunk);
          }
          return observer?.(chunk, stream);
        },
      });
      return { ...result, stderr: stripTrace(result.stderr) };
    },
    hidesLine,
    stripTrace,
    annotate: (step) => {
      const line = diagnostic();
      if (line) {
        step.diagnostics = [line, ...(step.diagnostics ?? [])];
      }
      return step;
    },
  };
}
